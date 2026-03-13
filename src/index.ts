/**
 * @perkos/perkos-a2a -- OpenClaw Plugin
 *
 * Agent-to-Agent (A2A) protocol communication plugin.
 * Adds tools for agents to discover peers, send tasks, and check task status.
 * Runs an A2A-compliant HTTP server alongside the OpenClaw gateway.
 */

import { A2AServer, detectNetworking } from "./server.js";
import type { A2APluginConfig } from "./types.js";

export { A2AServer, detectNetworking } from "./server.js";
export * from "./types.js";

export default function register(api: any) {
  const pluginConfig: A2APluginConfig = api.config?.plugins?.entries?.["perkos-a2a"]?.config || {
    agentName: "agent",
    port: 5050,
    skills: [],
    peers: {},
  };

  const logger = api.logger || console;
  const server = new A2AServer(pluginConfig, logger);

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
    name: "a2a_send_task",
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
    name: "a2a_discover",
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
    name: "a2a_task_status",
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
          description: "The task ID returned from a2a_send_task",
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
        const response = await fetch(`${targetUrl}/a2a/jsonrpc`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
  api.registerGatewayMethod("a2a.status", ({ respond }: any) => {
    respond(true, {
      agent: pluginConfig.agentName,
      port: pluginConfig.port,
      mode: pluginConfig.mode || "auto",
      clientOnly: server.isClientOnly(),
      peers: Object.keys(pluginConfig.peers),
      protocol: "a2a",
      version: "0.4.0",
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
          console.log(`Peers: ${Object.keys(pluginConfig.peers).join(", ") || "(none)"}`);
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

          // Check port availability
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

          console.log("\n--- Recommendations ---\n");

          if (!net.isBehindNat) {
            console.log("You're good! Configure peers with your public IP.");
            console.log(`  Your A2A URL: http://${net.publicIp}:${pluginConfig.port}/a2a/jsonrpc`);
          } else if (net.hasTailscale && net.tailscaleIp) {
            console.log("Use your Tailscale IP for peers.");
            console.log(`  Your A2A URL: http://${net.tailscaleIp}:${pluginConfig.port}/a2a/jsonrpc`);
          } else {
            console.log("You are behind NAT. Options:");
            console.log("  1) Install Tailscale (recommended) - https://tailscale.com");
            console.log("  2) Set up a Cloudflare Tunnel");
            console.log('  3) Client-only mode (can send tasks but not receive) - set mode: "client-only"');
          }

          if (!portAvailable) {
            console.log(`\nWarning: Port ${pluginConfig.port} is in use. Change the port in your config or stop the conflicting service.`);
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
