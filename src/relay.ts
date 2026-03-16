/**
 * A2A Relay Hub
 *
 * Lightweight WebSocket broker for NAT traversal. Agents connect outbound
 * to the relay, which routes messages between them. Supports API key auth,
 * rate limiting, agent presence registry, and offline message queuing.
 *
 * Can run standalone via bin/relay.ts or embedded in full mode.
 */

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import type { RelayMessage, RelayAgentEntry, AgentCard } from "./types.js";

interface ConnectedAgent {
  name: string;
  ws: WebSocket;
  apiKey: string;
  card?: AgentCard;
  connectedAt: string;
  lastHeartbeat: string;
}

interface QueuedMessage {
  message: RelayMessage;
  queuedAt: string;
}

export interface RelayHubConfig {
  port: number;
  /** Accepted API keys. If empty, auth is disabled. */
  apiKeys: string[];
  /** Maximum queued messages per offline agent */
  maxQueuePerAgent: number;
  /** Rate limit: max messages per agent per minute */
  rateLimitPerMinute: number;
  /** Heartbeat interval in milliseconds */
  heartbeatIntervalMs: number;
  /** Consider agent dead after this many missed heartbeats */
  heartbeatTimeoutMs: number;
}

const DEFAULT_CONFIG: RelayHubConfig = {
  port: 6060,
  apiKeys: [],
  maxQueuePerAgent: 200,
  rateLimitPerMinute: 60,
  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutMs: 90_000,
};

export class RelayHub {
  private wss: WebSocketServer | null = null;
  private agents: Map<string, ConnectedAgent> = new Map();
  private offlineQueue: Map<string, QueuedMessage[]> = new Map();
  private rateCounts: Map<string, { count: number; windowStart: number }> = new Map();
  private config: RelayHubConfig;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

  constructor(
    config?: Partial<RelayHubConfig>,
    logger?: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger || { info: console.log, error: console.error };
  }

  start(): void {
    this.wss = new WebSocketServer({ port: this.config.port });
    this.logger.info(`[perkos-a2a] Relay hub listening on port ${this.config.port}`);

    this.wss.on("connection", (ws, req) => {
      const remoteAddr = req.socket.remoteAddress || "unknown";
      this.logger.info(`[perkos-a2a] Relay connection from ${remoteAddr}`);
      this.handleConnection(ws);
    });

    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), this.config.heartbeatIntervalMs);
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.wss) {
      for (const agent of this.agents.values()) {
        agent.ws.close(1001, "Relay shutting down");
      }
      this.wss.close();
      this.wss = null;
      this.logger.info("[perkos-a2a] Relay hub stopped");
    }
  }

  getRegistry(): RelayAgentEntry[] {
    const entries: RelayAgentEntry[] = [];
    for (const agent of this.agents.values()) {
      entries.push({
        name: agent.name,
        connectedAt: agent.connectedAt,
        lastHeartbeat: agent.lastHeartbeat,
        card: agent.card,
      });
    }
    return entries;
  }

  private handleConnection(ws: WebSocket): void {
    let agentName: string | null = null;

    ws.on("message", (data) => {
      let msg: RelayMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        this.sendError(ws, "invalid_json", "Failed to parse message");
        return;
      }

      if (msg.type === "register") {
        agentName = this.handleRegister(ws, msg);
        return;
      }

      if (!agentName) {
        this.sendError(ws, "not_registered", "Must register before sending messages");
        return;
      }

      if (!this.checkRateLimit(agentName)) {
        this.sendError(ws, "rate_limited", "Rate limit exceeded");
        return;
      }

      switch (msg.type) {
        case "task":
        case "task_response":
          this.routeMessage(agentName, msg);
          break;
        case "discover":
          this.handleDiscover(ws, msg);
          break;
        case "heartbeat":
          this.handleHeartbeat(agentName, msg);
          break;
        default:
          this.sendError(ws, "unknown_type", `Unknown message type: ${msg.type}`);
      }
    });

    ws.on("close", () => {
      if (agentName) {
        this.agents.delete(agentName);
        this.logger.info(`[perkos-a2a] Agent disconnected: ${agentName}`);
      }
    });

    ws.on("error", (err) => {
      this.logger.error(`[perkos-a2a] WebSocket error for ${agentName || "unknown"}: ${err.message}`);
    });
  }

  private handleRegister(ws: WebSocket, msg: RelayMessage): string | null {
    const name = msg.payload.agentName as string;
    const apiKey = msg.payload.apiKey as string;

    if (!name) {
      this.sendError(ws, "missing_name", "agentName is required for registration");
      return null;
    }

    if (this.config.apiKeys.length > 0 && !this.config.apiKeys.includes(apiKey)) {
      this.sendError(ws, "auth_failed", "Invalid API key");
      ws.close(4001, "Authentication failed");
      return null;
    }

    // Disconnect existing connection for same agent name
    const existing = this.agents.get(name);
    if (existing) {
      existing.ws.close(4002, "Replaced by new connection");
    }

    const now = new Date().toISOString();
    this.agents.set(name, {
      name,
      ws,
      apiKey: apiKey || "",
      card: msg.payload.card as AgentCard | undefined,
      connectedAt: now,
      lastHeartbeat: now,
    });

    this.logger.info(`[perkos-a2a] Agent registered: ${name}`);

    const ack: RelayMessage = {
      type: "register_ack",
      id: msg.id,
      from: "relay",
      payload: { status: "ok", agentName: name },
      timestamp: now,
    };
    ws.send(JSON.stringify(ack));

    // Deliver queued messages
    this.drainQueue(name, ws);

    return name;
  }

  private routeMessage(fromAgent: string, msg: RelayMessage): void {
    const target = msg.to;
    if (!target) {
      this.sendError(this.agents.get(fromAgent)!.ws, "missing_target", "Message requires 'to' field");
      return;
    }

    msg.from = fromAgent;
    msg.timestamp = new Date().toISOString();

    const targetAgent = this.agents.get(target);
    if (targetAgent && targetAgent.ws.readyState === WebSocket.OPEN) {
      targetAgent.ws.send(JSON.stringify(msg));
    } else {
      // Queue for offline delivery
      if (!this.offlineQueue.has(target)) {
        this.offlineQueue.set(target, []);
      }
      const queue = this.offlineQueue.get(target)!;
      if (queue.length < this.config.maxQueuePerAgent) {
        queue.push({ message: msg, queuedAt: new Date().toISOString() });
        this.logger.info(`[perkos-a2a] Queued message for offline agent: ${target} (${queue.length} pending)`);
      } else {
        this.logger.info(`[perkos-a2a] Queue full for agent: ${target}, dropping message`);
        const sender = this.agents.get(fromAgent);
        if (sender) {
          this.sendError(sender.ws, "queue_full", `Target agent ${target} queue is full`);
        }
      }
    }
  }

  private drainQueue(agentName: string, ws: WebSocket): void {
    const queue = this.offlineQueue.get(agentName);
    if (!queue || queue.length === 0) return;

    this.logger.info(`[perkos-a2a] Delivering ${queue.length} queued messages to ${agentName}`);
    for (const item of queue) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(item.message));
      }
    }
    this.offlineQueue.delete(agentName);
  }

  private handleDiscover(ws: WebSocket, msg: RelayMessage): void {
    const agents: RelayAgentEntry[] = this.getRegistry();
    const response: RelayMessage = {
      type: "discover_response",
      id: msg.id,
      from: "relay",
      payload: { agents },
      timestamp: new Date().toISOString(),
    };
    ws.send(JSON.stringify(response));
  }

  private handleHeartbeat(agentName: string, msg: RelayMessage): void {
    const agent = this.agents.get(agentName);
    if (agent) {
      agent.lastHeartbeat = new Date().toISOString();
    }
    const ack: RelayMessage = {
      type: "heartbeat_ack",
      id: msg.id,
      from: "relay",
      payload: {},
      timestamp: new Date().toISOString(),
    };
    const ws = agent?.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(ack));
    }
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    for (const [name, agent] of this.agents) {
      const lastBeat = new Date(agent.lastHeartbeat).getTime();
      if (now - lastBeat > this.config.heartbeatTimeoutMs) {
        this.logger.info(`[perkos-a2a] Agent ${name} timed out (no heartbeat)`);
        agent.ws.close(4003, "Heartbeat timeout");
        this.agents.delete(name);
      }
    }
  }

  private checkRateLimit(agentName: string): boolean {
    const now = Date.now();
    const window = 60_000;
    let entry = this.rateCounts.get(agentName);

    if (!entry || now - entry.windowStart > window) {
      entry = { count: 0, windowStart: now };
      this.rateCounts.set(agentName, entry);
    }

    entry.count++;
    return entry.count <= this.config.rateLimitPerMinute;
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    const errorMsg: RelayMessage = {
      type: "error",
      id: randomUUID(),
      from: "relay",
      payload: { code, message },
      timestamp: new Date().toISOString(),
    };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(errorMsg));
    }
  }
}
