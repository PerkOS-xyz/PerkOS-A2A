/**
 * A2A Protocol Server
 * Express-based JSON-RPC 2.0 server with Agent Card discovery.
 * Supports full, client-only, relay, and auto modes.
 * Integrates with the relay hub for NAT traversal when configured.
 */

import express from "express";
import { randomUUID } from "crypto";
import { homedir, networkInterfaces } from "os";
import { RelayClient } from "./relay-client.js";
import { RelayHub } from "./relay.js";
import type {
  AgentCard,
  Task,
  Message,
  JsonRpcResponse,
  A2APluginConfig,
  RelayMessage,
  RelayAgentEntry,
} from "./types.js";

/** Detect if the host is behind NAT by comparing public IP to local interfaces */
export async function detectNetworking(): Promise<{
  isBehindNat: boolean;
  publicIp: string | null;
  localIps: string[];
  hasTailscale: boolean;
  tailscaleIp: string | null;
}> {
  const localIps: string[] = [];
  const ifaces = networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (!a.internal && a.family === "IPv4") {
        localIps.push(a.address);
      }
    }
  }

  let publicIp: string | null = null;
  try {
    const res = await fetch("https://api.ipify.org?format=text", {
      signal: AbortSignal.timeout(5000),
    });
    publicIp = (await res.text()).trim();
  } catch {
    // unable to reach internet
  }

  const isBehindNat = publicIp !== null && !localIps.includes(publicIp);

  let hasTailscale = false;
  let tailscaleIp: string | null = null;
  try {
    const { execSync } = await import("child_process");
    execSync("which tailscale", { stdio: "ignore" });
    hasTailscale = true;
    try {
      tailscaleIp = execSync("tailscale ip -4", { encoding: "utf-8" }).trim();
    } catch {
      // tailscale installed but not connected
    }
  } catch {
    // tailscale not installed
  }

  return { isBehindNat, publicIp, localIps, hasTailscale, tailscaleIp };
}

export class A2AServer {
  private app: express.Express;
  private tasks: Map<string, Task> = new Map();
  private agentCard: AgentCard;
  private config: A2APluginConfig;
  private logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  private clientOnly = false;
  private relayClient: RelayClient | null = null;
  private relayHub: RelayHub | null = null;
  private messageInjector: ((text: string, metadata?: Record<string, unknown>) => void) | null = null;

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

  /** Set the message injector for delivering tasks into the agent session */
  setMessageInjector(injector: (text: string, metadata?: Record<string, unknown>) => void): void {
    this.messageInjector = injector;
  }

  isClientOnly(): boolean {
    return this.clientOnly;
  }

  isRelayConnected(): boolean {
    return this.relayClient?.isConnected() || false;
  }

  private authMiddleware(): express.RequestHandler {
    return (req, res, next) => {
      if (!this.config.auth?.requireApiKey) {
        next();
        return;
      }

      const apiKey =
        req.headers["x-api-key"] as string ||
        req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
        (req.query["apiKey"] as string);

      if (!apiKey || !this.config.auth.apiKeys.includes(apiKey)) {
        res.status(401).json({ error: "Unauthorized: invalid or missing API key" });
        return;
      }

      next();
    };
  }

  private setupRoutes(): void {
    // Public endpoints (no auth required)
    this.app.get("/.well-known/agent-card.json", (_req, res) => {
      res.json(this.agentCard);
    });

    this.app.get("/health", (_req, res) => {
      res.json({
        ok: true,
        agent: this.config.agentName,
        protocol: "a2a",
        version: "0.5.0",
        peers: Object.keys(this.config.peers),
        taskCount: this.tasks.size,
        relayConnected: this.isRelayConnected(),
      });
    });

    // Protected endpoints
    const auth = this.authMiddleware();

    this.app.post("/a2a/jsonrpc", auth, async (req, res) => {
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
        this.logger.error(`[perkos-a2a] RPC error: ${msg}`);
        res.json(this.error(id, -32603, msg));
      }
    });

    this.app.get("/a2a/peers", auth, async (_req, res) => {
      const results = await this.discoverPeers();
      res.json(results);
    });

    this.app.post("/a2a/send", auth, async (req, res) => {
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
      `[perkos-a2a] Task ${taskId} received from ${task.metadata?.fromAgent}`
    );

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

    try {
      // Attempt session injection first
      if (this.messageInjector) {
        this.messageInjector(textParts, {
          source: "a2a",
          fromAgent: task.metadata?.fromAgent,
          taskId: task.id,
        });
        task.artifacts.push({
          kind: "artifact",
          artifactId: randomUUID(),
          parts: [{ kind: "text", text: "Task injected into agent session" }],
        });
      } else {
        // Fallback: write to file
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
      }

      task.status = {
        state: "completed",
        timestamp: new Date().toISOString(),
      };

      this.logger.info(`[perkos-a2a] Task ${task.id} completed`);
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
      this.logger.error(`[perkos-a2a] Task ${task.id} failed: ${msg}`);
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

  /** Send a task to a peer agent via A2A protocol (direct HTTP or relay) */
  async sendTask(
    targetAgent: string,
    messageText: string
  ): Promise<JsonRpcResponse> {
    const targetUrl = this.config.peers[targetAgent];

    // Try direct HTTP first if peer URL is configured
    if (targetUrl) {
      try {
        return await this.sendTaskDirect(targetAgent, targetUrl, messageText);
      } catch (err) {
        // If relay is available, fall through to relay
        if (!this.relayClient?.isConnected()) {
          throw err;
        }
        this.logger.info(
          `[perkos-a2a] Direct send to ${targetAgent} failed, falling back to relay`
        );
      }
    }

    // Try relay
    if (this.relayClient?.isConnected()) {
      return this.sendTaskViaRelay(targetAgent, messageText);
    }

    throw new Error(
      `Cannot reach ${targetAgent}: no direct URL configured and relay not connected. ` +
      `Known peers: ${Object.keys(this.config.peers).join(", ")}`
    );
  }

  private async sendTaskDirect(
    targetAgent: string,
    targetUrl: string,
    messageText: string
  ): Promise<JsonRpcResponse> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    // Include auth token if peer has one configured
    const peerAuth = (this.config as any).peerAuth?.[targetAgent];
    if (peerAuth) {
      headers["x-api-key"] = peerAuth;
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
      headers,
      body: JSON.stringify(payload),
    });

    return (await response.json()) as JsonRpcResponse;
  }

  private async sendTaskViaRelay(
    targetAgent: string,
    messageText: string
  ): Promise<JsonRpcResponse> {
    const rpcId = randomUUID();
    const result = await this.relayClient!.sendTask(targetAgent, {
      jsonrpc: "2.0",
      method: "message/send",
      id: rpcId,
      params: {
        message: {
          kind: "message",
          messageId: randomUUID(),
          role: "user",
          parts: [{ kind: "text", text: messageText }],
          metadata: { fromAgent: this.config.agentName },
        },
      },
    });

    return (result.payload as unknown as JsonRpcResponse) || this.success(rpcId, result.payload);
  }

  /** Discover all peer agents (direct + relay) */
  async discoverPeers(): Promise<
    Record<string, { status: string; card?: AgentCard }>
  > {
    const results: Record<string, { status: string; card?: AgentCard }> = {};

    // Direct peer discovery
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

    // Relay discovery (merge, relay overrides offline status from direct)
    if (this.relayClient?.isConnected()) {
      try {
        const relayAgents = await this.relayClient.discover();
        for (const agent of relayAgents) {
          if (agent.name === this.config.agentName) continue;
          const existing = results[agent.name];
          if (!existing || existing.status === "offline") {
            results[agent.name] = {
              status: "online",
              card: agent.card,
            };
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[perkos-a2a] Relay discovery failed: ${msg}`);
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

  /** Handle an inbound task received via the relay */
  private handleRelayTask(msg: RelayMessage): void {
    const payload = msg.payload as any;
    const params = payload.params || payload;
    const rpcId = payload.id || msg.id;

    this.handleSendMessage(params, rpcId).then((response) => {
      this.relayClient?.sendTaskResponse(msg, response as unknown as Record<string, unknown>);
    }).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[perkos-a2a] Failed to process relay task: ${errMsg}`);
      this.relayClient?.sendTaskResponse(msg, this.error(rpcId, -32603, errMsg) as unknown as Record<string, unknown>);
    });
  }

  private startRelayClient(): void {
    const relay = this.config.relay;
    if (!relay?.enabled || !relay?.url) return;

    this.relayClient = new RelayClient({
      agentName: this.config.agentName,
      relay,
      card: this.agentCard,
      onTask: (msg) => this.handleRelayTask(msg),
      logger: this.logger,
    });

    this.relayClient.start();
    this.logger.info(`[perkos-a2a] Relay client started, connecting to ${relay.url}`);
  }

  private startRelayHub(): void {
    const relayConfig = this.config.relay;
    this.relayHub = new RelayHub(
      {
        port: this.config.port,
        apiKeys: this.config.auth?.apiKeys || [],
        maxQueuePerAgent: 200,
        rateLimitPerMinute: 60,
        heartbeatIntervalMs: 30_000,
        heartbeatTimeoutMs: 90_000,
      },
      this.logger
    );
    this.relayHub.start();
  }

  async start(): Promise<void> {
    const mode = this.config.mode || "auto";

    if (mode === "relay") {
      this.clientOnly = true;
      this.startRelayHub();
      return;
    }

    if (mode === "client-only") {
      this.clientOnly = true;
      this.startRelayClient();
      if (!this.config.relay?.enabled) {
        this.logger.info(
          "[perkos-a2a] Running in client-only mode. Configure relay for NAT traversal or set up Tailscale/tunnel."
        );
      }
      return;
    }

    if (mode === "full") {
      this.tryListen(this.config.port);
      this.startRelayClient();
      return;
    }

    // auto mode: detect networking, decide
    try {
      const net = await detectNetworking();
      if (net.isBehindNat && !net.hasTailscale) {
        if (this.config.relay?.enabled) {
          this.logger.info(
            "[perkos-a2a] Behind NAT, using relay for bidirectional communication"
          );
          this.clientOnly = true;
          this.startRelayClient();
        } else {
          this.logger.info(
            "[perkos-a2a] Running in client-only mode (behind NAT). Configure relay or Tailscale for bidirectional A2A."
          );
          this.clientOnly = true;
        }
        return;
      }
      if (net.isBehindNat && net.hasTailscale && net.tailscaleIp) {
        this.logger.info(
          `[perkos-a2a] Behind NAT but Tailscale detected (${net.tailscaleIp}). Starting server.`
        );
      }
    } catch {
      // detection failed, try to start anyway
    }

    this.tryListen(this.config.port);
    this.startRelayClient();
  }

  private tryListen(port: number, attempt = 1): void {
    const maxAttempts = 3;
    try {
      const srv = this.app.listen(port, "0.0.0.0", () => {
        this.logger.info(
          `[perkos-a2a] ${this.config.agentName} server on port ${port}`
        );
        this.agentCard.url = `http://localhost:${port}/a2a/jsonrpc`;
      });
      srv.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempt < maxAttempts) {
          const nextPort = port + 1;
          this.logger.info(`[perkos-a2a] Port ${port} in use, trying ${nextPort}`);
          this.tryListen(nextPort, attempt + 1);
        } else if (err.code === "EADDRINUSE") {
          this.logger.info(
            `[perkos-a2a] Ports ${this.config.port}-${port} all in use. Falling back to client-only mode.`
          );
          this.clientOnly = true;
        } else {
          this.logger.error(`[perkos-a2a] Server error: ${err.message}`);
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[perkos-a2a] Failed to start server: ${msg}`);
    }
  }

  getExpressApp(): express.Express {
    return this.app;
  }
}
