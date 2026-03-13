/**
 * A2A Protocol Server
 * Express-based JSON-RPC 2.0 server with Agent Card discovery
 */

import express from "express";
import { randomUUID } from "crypto";
import { homedir } from "os";
import type {
  AgentCard,
  Task,
  Message,
  JsonRpcResponse,
  A2APluginConfig,
} from "./types.js";

export class A2AServer {
  private app: express.Express;
  private tasks: Map<string, Task> = new Map();
  private agentCard: AgentCard;
  private config: A2APluginConfig;
  private logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

  constructor(
    config: A2APluginConfig,
    logger?: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
  ) {
    this.config = config;
    this.logger = logger || { info: console.log, error: console.error };
    this.app = express();
    this.app.use(express.json());

    this.agentCard = {
      name: config.agentName,
      description: `PerkOS agent: ${config.agentName}`,
      protocolVersion: "0.3.0",
      version: "1.0.0",
      url: `http://localhost:${config.port}/a2a/jsonrpc`,
      skills: config.skills || [],
      capabilities: { pushNotifications: false },
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
    };

    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Agent Card discovery
    this.app.get("/.well-known/agent-card.json", (_req, res) => {
      res.json(this.agentCard);
    });

    // Health check
    this.app.get("/health", (_req, res) => {
      res.json({
        ok: true,
        agent: this.config.agentName,
        protocol: "a2a",
        version: "0.3.0",
        peers: Object.keys(this.config.peers),
        taskCount: this.tasks.size,
      });
    });

    // JSON-RPC 2.0 endpoint
    this.app.post("/a2a/jsonrpc", async (req, res) => {
      const { method, params, id } = req.body;

      try {
        let result: JsonRpcResponse;
        switch (method) {
          case "message/send":
            result = await this.handleSendMessage(params, id);
            break;
          case "tasks/get":
            result = this.handleGetTask(params, id);
            break;
          case "tasks/list":
            result = this.handleListTasks(id);
            break;
          case "tasks/cancel":
            result = this.handleCancelTask(params, id);
            break;
          case "agent/card":
            result = this.success(id, this.agentCard);
            break;
          default:
            result = this.error(id, -32601, `Method not found: ${method}`);
        }
        res.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[a2a] RPC error: ${msg}`);
        res.json(this.error(id, -32603, msg));
      }
    });

    // Peer discovery
    this.app.get("/a2a/peers", async (_req, res) => {
      const results: Record<string, unknown> = {};
      for (const [name, url] of Object.entries(this.config.peers)) {
        try {
          const r = await fetch(`${url}/.well-known/agent-card.json`, {
            signal: AbortSignal.timeout(3000),
          });
          results[name] = { status: "online", card: await r.json() };
        } catch {
          results[name] = { status: "offline" };
        }
      }
      res.json(results);
    });

    // Send task to peer (REST convenience)
    this.app.post("/a2a/send", async (req, res) => {
      const { target, message } = req.body;
      try {
        const result = await this.sendTask(target, message);
        res.json({ ok: true, result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ ok: false, error: msg });
      }
    });
  }

  private async handleSendMessage(
    params: Record<string, unknown>,
    rpcId: string
  ): Promise<JsonRpcResponse> {
    const message = params.message as Message;
    const taskId = randomUUID();
    const contextId = message?.contextId || randomUUID();

    const task: Task = {
      kind: "task",
      id: taskId,
      contextId,
      status: { state: "submitted", timestamp: new Date().toISOString() },
      messages: [message],
      artifacts: [],
      metadata: {
        fromAgent: (message?.metadata?.fromAgent as string) || "unknown",
      },
    };

    this.tasks.set(taskId, task);
    this.logger.info(
      `[a2a] Task ${taskId} received from ${task.metadata?.fromAgent}`
    );

    // Process asynchronously
    this.processTask(task);

    return this.success(rpcId, task);
  }

  private async processTask(task: Task): Promise<void> {
    task.status = { state: "working", timestamp: new Date().toISOString() };

    const textParts = task.messages
      .flatMap((m) => m.parts || [])
      .filter((p) => p.kind === "text")
      .map((p) => p.text)
      .join("\n");

    // Write task to workspace for OpenClaw agent to process
    try {
      const fs = await import("fs");
      const taskDir = (this.config as any).workspacePath
        || `${process.env.HOME || homedir()}/.openclaw/workspace/memory`;
      if (!fs.existsSync(taskDir)) {
        fs.mkdirSync(taskDir, { recursive: true });
      }

      const taskFile = `${taskDir}/a2a-task-${task.id}.md`;
      const content = [
        "# A2A Task",
        "",
        `**From:** ${task.metadata?.fromAgent}`,
        `**Task ID:** ${task.id}`,
        `**Time:** ${new Date().toISOString()}`,
        "",
        "## Message",
        "",
        textParts,
        "",
      ].join("\n");

      fs.writeFileSync(taskFile, content);

      task.artifacts.push({
        kind: "artifact",
        artifactId: randomUUID(),
        parts: [{ kind: "text", text: `Task queued: ${taskFile}` }],
      });

      task.status = {
        state: "completed",
        timestamp: new Date().toISOString(),
      };

      this.logger.info(`[a2a] Task ${task.id} completed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      task.status = {
        state: "failed",
        timestamp: new Date().toISOString(),
        message: {
          role: "agent",
          parts: [{ kind: "text", text: msg }],
        },
      };
      this.logger.error(`[a2a] Task ${task.id} failed: ${msg}`);
    }
  }

  private handleGetTask(
    params: Record<string, unknown>,
    rpcId: string
  ): JsonRpcResponse {
    const task = this.tasks.get(params?.id as string);
    if (!task) return this.error(rpcId, 404, "Task not found");
    return this.success(rpcId, task);
  }

  private handleListTasks(rpcId: string): JsonRpcResponse {
    const allTasks = Array.from(this.tasks.values()).sort(
      (a, b) =>
        new Date(b.status.timestamp).getTime() -
        new Date(a.status.timestamp).getTime()
    );
    return this.success(rpcId, { tasks: allTasks, nextPageToken: "" });
  }

  private handleCancelTask(
    params: Record<string, unknown>,
    rpcId: string
  ): JsonRpcResponse {
    const task = this.tasks.get(params?.id as string);
    if (!task) return this.error(rpcId, 404, "Task not found");
    if (["completed", "failed", "canceled"].includes(task.status.state)) {
      return this.error(rpcId, 409, "Task not cancelable");
    }
    task.status = { state: "canceled", timestamp: new Date().toISOString() };
    return this.success(rpcId, task);
  }

  /** Send a task to a peer agent via A2A protocol */
  async sendTask(
    targetAgent: string,
    messageText: string
  ): Promise<JsonRpcResponse> {
    const targetUrl = this.config.peers[targetAgent];
    if (!targetUrl) {
      throw new Error(
        `Unknown peer: ${targetAgent}. Known peers: ${Object.keys(this.config.peers).join(", ")}`
      );
    }

    const payload = {
      jsonrpc: "2.0",
      method: "message/send",
      id: randomUUID(),
      params: {
        message: {
          kind: "message",
          messageId: randomUUID(),
          role: "user",
          parts: [{ kind: "text", text: messageText }],
          metadata: { fromAgent: this.config.agentName },
        },
      },
    };

    const response = await fetch(`${targetUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    return (await response.json()) as JsonRpcResponse;
  }

  /** Discover all peer agents */
  async discoverPeers(): Promise<
    Record<string, { status: string; card?: AgentCard }>
  > {
    const results: Record<string, { status: string; card?: AgentCard }> = {};
    for (const [name, url] of Object.entries(this.config.peers)) {
      try {
        const r = await fetch(`${url}/.well-known/agent-card.json`, {
          signal: AbortSignal.timeout(3000),
        });
        results[name] = { status: "online", card: (await r.json()) as AgentCard };
      } catch {
        results[name] = { status: "offline" };
      }
    }
    return results;
  }

  private success(id: string, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }

  private error(id: string, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  start(): void {
    try {
      const srv = this.app.listen(this.config.port, "0.0.0.0", () => {
        this.logger.info(
          `[a2a] ${this.config.agentName} server on port ${this.config.port}`
        );
      });
      srv.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          this.logger.error(`[a2a] Port ${this.config.port} in use, skipping`);
        } else {
          this.logger.error(`[a2a] Server error: ${err.message}`);
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[a2a] Failed to start server: ${msg}`);
    }
  }

  getExpressApp(): express.Express {
    return this.app;
  }
}
