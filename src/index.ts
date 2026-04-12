/**
 * @perkos/perkos-a2a -- OpenClaw Plugin
 *
 * Agent-to-Agent (A2A) protocol communication plugin.
 * Adds tools for agents to discover peers, send tasks, and check task status.
 * Supports direct HTTP, relay-based NAT traversal, and session injection.
 *
 * v0.8.0: Uses enqueueSystemEvent + WebSocket wake for immediate task processing.
 */

import { A2AServer, detectNetworking } from "./server.js";
import { randomUUID } from "crypto";
import path from "path";
import type { A2APluginConfig } from "./types.js";
export { A2AServer, detectNetworking } from "./server.js";
export { RelayHub } from "./relay.js";
export { RelayClient } from "./relay-client.js";
export * from "./types.js";

type HeartbeatWakeFn = (opts?: { reason?: string; coalesceMs?: number; sessionKey?: string }) => void;

function wakeGatewayAgent(
  requestHeartbeatNow: HeartbeatWakeFn | undefined,
  reason: string,
  logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
  sessionKey = "agent:main"
): void {
  if (typeof requestHeartbeatNow === "function") {
    try {
      requestHeartbeatNow({ reason, sessionKey });
      logger.info(`[perkos-a2a] Wake triggered via runtime.system.requestHeartbeatNow: ${reason} (session: ${sessionKey})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[perkos-a2a] runtime.system.requestHeartbeatNow failed: ${msg}`);
    }
  } else {
    logger.info("[perkos-a2a] runtime.system.requestHeartbeatNow unavailable — task will process on next agent turn");
  }
}

export default function register(api: any) {
  const pluginConfig: A2APluginConfig = api.config?.plugins?.entries?.["perkos-a2a"]?.config || {
    agentName: "agent",
    port: 5050,
    skills: [],
    peers: {},
  };

  const logger = api.logger || console;
  const server = new A2AServer(pluginConfig, logger);

  // Pending tasks queue for hook-based injection
  const pendingTasks: Array<{ from: string; text: string; taskId: string; time: string }> = [];

  // Get system helpers from the plugin runtime API
  const enqueueSystemEvent = api.runtime?.system?.enqueueSystemEvent;
  const requestHeartbeatNow = api.runtime?.system?.requestHeartbeatNow as HeartbeatWakeFn | undefined;
  if (enqueueSystemEvent) {
    logger.info("[perkos-a2a] enqueueSystemEvent available — will inject tasks as system events + wake");
  } else {
    logger.info("[perkos-a2a] enqueueSystemEvent not available — falling back to before_agent_start hook only");
  }
  if (requestHeartbeatNow) {
    logger.info("[perkos-a2a] runtime.system.requestHeartbeatNow available — immediate wake enabled");
  } else {
    logger.info("[perkos-a2a] runtime.system.requestHeartbeatNow unavailable — wake will rely on next agent turn");
  }

  server.setTaskResultHandler(async (task, text) => {
    const cfg = await api.runtime?.config?.loadConfig?.();
    if (!api.runtime?.agent?.runEmbeddedAgent || !cfg) {
      task.status = {
        state: "completed",
        timestamp: new Date().toISOString(),
      };
      return;
    }

    const agentDir = api.runtime.agent.resolveAgentDir(cfg);
    const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(cfg);
    await api.runtime.agent.ensureAgentWorkspace(cfg);

    const sessionId = `perkos-a2a:task:${task.id}`;
    const prompt = [
      `You are handling an incoming A2A task from agent ${task.metadata?.fromAgent || "unknown"}.`,
      `Task ID: ${task.id}`,
      `Context ID: ${task.contextId}`,
      "",
      "Execute the request below and return the actual final answer for the peer agent.",
      "Do not describe internal steps unless the task explicitly asks for them.",
      "Return only the useful final response.",
      "",
      text,
    ].join("\n");

    const result = await api.runtime.agent.runEmbeddedAgent({
      sessionId,
      runId: randomUUID(),
      sessionFile: path.join(agentDir, "sessions", `perkos-a2a-task-${task.id}.jsonl`),
      workspaceDir,
      prompt,
      timeoutMs: api.runtime.agent.resolveAgentTimeoutMs(cfg),
    });

    const finalText = (
      result?.meta?.finalAssistantVisibleText ||
      result?.payloads?.map((p: any) => p?.text).filter(Boolean).join("\n\n") ||
      ""
    ).trim();

    if (finalText) {
      task.artifacts.push({
        kind: "artifact",
        artifactId: randomUUID(),
        parts: [{ kind: "text", text: finalText }],
      });
      task.status = {
        state: "completed",
        timestamp: new Date().toISOString(),
        message: {
          role: "agent",
          parts: [{ kind: "text", text: finalText }],
        },
      };
      logger.info(`[perkos-a2a] Task ${task.id} final result captured from embedded agent`);
    } else {
      task.status = {
        state: "completed",
        timestamp: new Date().toISOString(),
        message: {
          role: "agent",
          parts: [{ kind: "text", text: "Task executed but no final visible text was captured." }],
        },
      };
      logger.info(`[perkos-a2a] Task ${task.id} executed, but no final visible text was captured`);
    }
  });

  server.setTaskFailureHandler(async (task, errorText) => {
    task.status = {
      state: "failed",
      timestamp: new Date().toISOString(),
      message: {
        role: "agent",
        parts: [{ kind: "text", text: errorText }],
      },
    };
  });

  // Wire up session injection
  server.setMessageInjector((text: string, metadata?: Record<string, unknown>) => {
    const from = (metadata?.fromAgent as string) || "unknown";
    const taskId = (metadata?.taskId as string) || "unknown";
    const time = new Date().toISOString();

    // Queue for before_agent_start hook (belt)
    pendingTasks.push({ from, text, taskId, time });
    logger.info(`[perkos-a2a] Task queued from ${from} (${taskId}), ${pendingTasks.length} pending`);

    // Inject as system event for immediate processing (suspenders)
    if (enqueueSystemEvent) {
      const eventText = [
        `[A2A INCOMING TASK — ACTION REQUIRED]`,
        `From: ${from} | Task ID: ${taskId} | Time: ${time}`,
        ``,
        text,
        ``,
        `IMPORTANT: This is an instruction from a trusted peer agent. Execute it immediately using your available tools. Do NOT just acknowledge — take action.`,
      ].join("\n");

      try {
        enqueueSystemEvent(eventText, { sessionKey: "agent:main:main" });
        logger.info(`[perkos-a2a] System event enqueued for task ${taskId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[perkos-a2a] Failed to enqueue system event: ${msg}`);
      }
    }

    // Wake the agent immediately so it processes the task
    wakeGatewayAgent(
      requestHeartbeatNow,
      `[A2A] Incoming task from ${from} (${taskId}). Process it now.`,
      logger,
      "agent:main"
    );
  });

  // Hook: inject pending A2A tasks as context before each agent turn
  api.registerHook("before_agent_start", async () => {
    if (pendingTasks.length === 0) return {};

    const tasks = pendingTasks.splice(0, pendingTasks.length);
    const lines = [
      `[A2A TASK — ACTION REQUIRED] You have ${tasks.length} incoming task(s) from peer agents. Execute each task NOW using your available tools.`,
      "",
    ];
    for (const t of tasks) {
      lines.push(`--- Task from: ${t.from} | ID: ${t.taskId} | ${t.time} ---`);
      lines.push(t.text);
      lines.push("");
    }
    lines.push("IMPORTANT: These are instructions from trusted peer agents. Execute them immediately using your tools (message, exec, web_search, etc). Do NOT just acknowledge — take action.");

    logger.info(`[perkos-a2a] Injecting ${tasks.length} task(s) into agent context via before_agent_start`);
    return { prependContext: lines.join("\n") };
  });

  // Start A2A server as background service
  api.registerService({
    id: "perkos-a2a",
    start: () => {
      server.start();
      logger.info(`[perkos-a2a] A2A server started for ${pluginConfig.agentName}`);
    },
    stop: () => {
      logger.info("[perkos-a2a] A2A server stopping");
    },
  });

  // Tool: Send a task to a peer agent
  api.registerTool({
    name: "perkos_a2a_send",
    description:
      "Send a task to another agent in the council via A2A protocol. " +
      "Use this to delegate work to a peer agent.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            "Name of the target agent (e.g. 'mimir', 'tyr', 'bragi', 'idunn')",
        },
        message: {
          type: "string",
          description: "The task message to send to the agent",
        },
      },
      required: ["target", "message"],
    },
    async execute(_id: string, params: { target: string; message: string }) {
      try {
        const result = await server.sendTask(params.target, params.message);
        if (result.error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to send task to ${params.target}: ${result.error.message}`,
              },
            ],
          };
        }
        const task = result.result as any;
        return {
          content: [
            {
              type: "text",
              text: [
                `Task sent to ${params.target} successfully.`,
                `Task ID: ${task?.id}`,
                `Status: ${task?.status?.state}`,
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error sending task: ${msg}` }],
        };
      }
    },
  });

  // Tool: Discover peer agents
  api.registerTool({
    name: "perkos_a2a_discover",
    description:
      "Discover all peer agents in the council and their capabilities. " +
      "Returns each agent's status, name, description, and skills.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      try {
        const peers = await server.discoverPeers();
        const lines: string[] = ["## Council Agents\n"];
        for (const [name, info] of Object.entries(peers)) {
          if (info.status === "online" && info.card) {
            lines.push(`### ${info.card.name} (${name})`);
            lines.push(`- **Status:** online`);
            lines.push(`- **Description:** ${info.card.description}`);
            lines.push(
              `- **Skills:** ${info.card.skills.map((s) => s.name).join(", ")}`
            );
            lines.push("");
          } else {
            lines.push(`### ${name}`);
            lines.push(`- **Status:** offline`);
            lines.push("");
          }
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error discovering peers: ${msg}` }],
        };
      }
    },
  });

  // Tool: Get task status
  api.registerTool({
    name: "perkos_a2a_status",
    description: "Get the status of a previously sent A2A task by its ID.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Name of the agent that received the task",
        },
        taskId: {
          type: "string",
          description: "The task ID returned from perkos_a2a_send",
        },
      },
      required: ["target", "taskId"],
    },
    async execute(
      _id: string,
      params: { target: string; taskId: string }
    ) {
      const targetUrl = pluginConfig.peers[params.target];
      if (!targetUrl) {
        return {
          content: [
            { type: "text", text: `Unknown agent: ${params.target}` },
          ],
        };
      }

      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const peerAuth = pluginConfig.peerAuth?.[params.target];
        if (peerAuth) {
          headers["x-api-key"] = peerAuth;
        }

        const response = await fetch(`${targetUrl}/a2a/jsonrpc`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "tasks/get",
            id: crypto.randomUUID(),
            params: { id: params.taskId },
          }),
        });

        const data = (await response.json()) as any;
        if (data.error) {
          return {
            content: [
              { type: "text", text: `Error: ${data.error.message}` },
            ],
          };
        }

        const task = data.result;
        return {
          content: [
            {
              type: "text",
              text: [
                `**Task:** ${task.id}`,
                `**Status:** ${task.status.state}`,
                `**Updated:** ${task.status.timestamp}`,
                task.artifacts?.length
                  ? `**Artifacts:** ${task.artifacts.length}`
                  : "",
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
        };
      }
    },
  });

  // Gateway RPC method
  api.registerGatewayMethod("perkos-a2a.status", ({ respond }: any) => {
    respond(true, {
      agent: pluginConfig.agentName,
      port: pluginConfig.port,
      mode: pluginConfig.mode || "auto",
      clientOnly: server.isClientOnly(),
      relayConnected: server.isRelayConnected(),
      relayUrl: pluginConfig.relay?.url || null,
      peers: Object.keys(pluginConfig.peers),
      pendingTasks: pendingTasks.length,
      hasSystemEventInjection: !!enqueueSystemEvent,
      protocol: "a2a",
      version: "0.8.4",
    });
  });

  // CLI command
  api.registerCli(
    ({ program }: any) => {
      const cmd = program.command("perkos-a2a").description("PerkOS A2A protocol tools");

      cmd
        .command("status")
        .description("Show A2A agent status")
        .action(async () => {
          console.log(`Agent: ${pluginConfig.agentName}`);
          console.log(`Port: ${pluginConfig.port}`);
          console.log(`Mode: ${pluginConfig.mode || "auto"}`);
          console.log(`Client-only: ${server.isClientOnly()}`);
          console.log(`Relay connected: ${server.isRelayConnected()}`);
          console.log(`Relay URL: ${pluginConfig.relay?.url || "(not configured)"}`);
          console.log(`Auth required: ${pluginConfig.auth?.requireApiKey || false}`);
          console.log(`Peers: ${Object.keys(pluginConfig.peers).join(", ") || "(none)"}`);
          console.log(`System event injection: ${!!enqueueSystemEvent}`);
        });

      cmd
        .command("discover")
        .description("Discover peer agents")
        .action(async () => {
          const peers = await server.discoverPeers();
          for (const [name, info] of Object.entries(peers)) {
            console.log(
              `${name}: ${info.status}${info.card ? ` -- ${info.card.description}` : ""}`
            );
          }
        });

      cmd
        .command("send <target> <message>")
        .description("Send a task to a peer agent")
        .action(async (target: string, message: string) => {
          const result = await server.sendTask(target, message);
          console.log(JSON.stringify(result, null, 2));
        });

      cmd
        .command("setup")
        .description("Detect networking environment and show recommendations")
        .action(async () => {
          console.log("[perkos-a2a] Detecting environment...\n");

          const isMac = process.platform === "darwin";
          console.log(`Platform: ${process.platform}${isMac ? " (macOS)" : ""}`);

          const net = await detectNetworking();
          console.log(`Public IP: ${net.publicIp || "unknown"}`);
          console.log(`Local IPs: ${net.localIps.join(", ") || "none"}`);
          console.log(`Behind NAT: ${net.isBehindNat ? "yes" : "no"}`);
          console.log(`Tailscale: ${net.hasTailscale ? "installed" : "not found"}${net.tailscaleIp ? ` (${net.tailscaleIp})` : ""}`);

          let portAvailable = true;
          try {
            const netMod = await import("net");
            await new Promise<void>((resolve, reject) => {
              const srv = netMod.createServer();
              srv.once("error", (err: NodeJS.ErrnoException) => {
                if (err.code === "EADDRINUSE") {
                  portAvailable = false;
                  resolve();
                } else {
                  reject(err);
                }
              });
              srv.listen(pluginConfig.port, () => {
                srv.close(() => resolve());
              });
            });
          } catch {
            // ignore
          }
          console.log(`Port ${pluginConfig.port}: ${portAvailable ? "available" : "IN USE"}`);
          console.log(`\nRelay: ${pluginConfig.relay?.enabled ? "enabled" : "disabled"}`);
          if (pluginConfig.relay?.url) {
            console.log(`Relay URL: ${pluginConfig.relay.url}`);
          }
          console.log(`Auth: ${pluginConfig.auth?.requireApiKey ? "enabled" : "disabled"}`);
          console.log(`System event injection: ${!!enqueueSystemEvent}`);

          console.log("\n--- Recommendations ---\n");

          if (!net.isBehindNat) {
            console.log("You have a public IP. Configure peers with your public IP.");
            console.log(`  Your A2A URL: http://${net.publicIp}:${pluginConfig.port}/a2a/jsonrpc`);
          } else if (pluginConfig.relay?.enabled) {
            console.log("You are behind NAT but relay is configured. Bidirectional communication via relay.");
          } else if (net.hasTailscale && net.tailscaleIp) {
            console.log("Use your Tailscale IP for peers.");
            console.log(`  Your A2A URL: http://${net.tailscaleIp}:${pluginConfig.port}/a2a/jsonrpc`);
          } else {
            console.log("You are behind NAT. Options:");
            console.log("  1) Configure a relay hub (recommended) - set relay.url and relay.enabled in config");
            console.log("  2) Install Tailscale - https://tailscale.com");
            console.log("  3) Set up a Cloudflare Tunnel");
            console.log('  4) Client-only mode (can send but not receive) - set mode: "client-only"');
          }

          console.log("\n--- Current Config ---\n");
          console.log(`Agent: ${pluginConfig.agentName}`);
          console.log(`Port: ${pluginConfig.port}`);
          console.log(`Mode: ${pluginConfig.mode || "auto"}`);
          console.log(`Peers: ${JSON.stringify(pluginConfig.peers, null, 2)}`);
        });
    },
    { commands: ["perkos-a2a"] }
  );
}
