/**
 * A2A Relay Client
 *
 * WebSocket client that connects to an A2A Relay Hub for NAT-friendly
 * bidirectional communication. Handles registration, auto-reconnect
 * with exponential backoff, heartbeats, and message routing.
 */

import WebSocket from "ws";
import { randomUUID } from "crypto";
import type { RelayMessage, RelayConfig, AgentCard, RelayAgentEntry } from "./types.js";

export interface RelayClientOptions {
  agentName: string;
  relay: RelayConfig;
  card?: AgentCard;
  /** Called when a task message arrives via the relay */
  onTask: (msg: RelayMessage) => void;
  /** Called when a discover response arrives */
  onDiscoverResponse?: (agents: RelayAgentEntry[]) => void;
  logger?: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 25_000;

export class RelayClient {
  private ws: WebSocket | null = null;
  private options: RelayClientOptions;
  private logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  private reconnectMs = MIN_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private stopped = false;
  private pendingCallbacks: Map<string, (msg: RelayMessage) => void> = new Map();

  constructor(options: RelayClientOptions) {
    this.options = options;
    this.logger = options.logger || { info: console.log, error: console.error };
  }

  isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, "Client shutting down");
      this.ws = null;
    }
    this.connected = false;
  }

  /** Send a task to another agent via the relay */
  async sendTask(targetAgent: string, payload: Record<string, unknown>): Promise<RelayMessage> {
    return this.sendAndWait({
      type: "task",
      to: targetAgent,
      id: randomUUID(),
      from: this.options.agentName,
      payload,
      timestamp: new Date().toISOString(),
    }, "task_response", 30_000);
  }

  /** Discover agents connected to the relay */
  async discover(): Promise<RelayAgentEntry[]> {
    const response = await this.sendAndWait({
      type: "discover",
      id: randomUUID(),
      from: this.options.agentName,
      payload: {},
      timestamp: new Date().toISOString(),
    }, "discover_response", 10_000);
    return (response.payload.agents as RelayAgentEntry[]) || [];
  }

  /** Send a task response back through the relay */
  sendTaskResponse(originalMsg: RelayMessage, result: Record<string, unknown>): void {
    const response: RelayMessage = {
      type: "task_response",
      id: originalMsg.id,
      from: this.options.agentName,
      to: originalMsg.from,
      payload: result,
      timestamp: new Date().toISOString(),
    };
    this.send(response);
  }

  private connect(): void {
    if (this.stopped) return;

    const url = this.options.relay.url;
    this.logger.info(`[perkos-a2a] Connecting to relay: ${url}`);

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[perkos-a2a] Failed to create WebSocket: ${msg}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.connected = true;
      this.reconnectMs = MIN_RECONNECT_MS;
      this.logger.info("[perkos-a2a] Connected to relay hub");
      this.register();
      this.startHeartbeat();
    });

    this.ws.on("message", (data) => {
      let msg: RelayMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        this.logger.error("[perkos-a2a] Failed to parse relay message");
        return;
      }
      this.handleMessage(msg);
    });

    this.ws.on("close", (code, reason) => {
      this.connected = false;
      this.clearTimers();
      if (!this.stopped) {
        this.logger.info(`[perkos-a2a] Relay connection closed (${code}: ${reason || "no reason"}). Reconnecting...`);
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (err) => {
      this.logger.error(`[perkos-a2a] Relay WebSocket error: ${err.message}`);
    });
  }

  private register(): void {
    const msg: RelayMessage = {
      type: "register",
      id: randomUUID(),
      from: this.options.agentName,
      payload: {
        agentName: this.options.agentName,
        apiKey: this.options.relay.apiKey,
        card: this.options.card,
      },
      timestamp: new Date().toISOString(),
    };
    this.send(msg);
  }

  private handleMessage(msg: RelayMessage): void {
    // Check for pending request/response callbacks
    const callback = this.pendingCallbacks.get(msg.id);
    if (callback) {
      this.pendingCallbacks.delete(msg.id);
      callback(msg);
      return;
    }

    switch (msg.type) {
      case "register_ack":
        this.logger.info("[perkos-a2a] Registered with relay hub");
        break;
      case "task":
        this.options.onTask(msg);
        break;
      case "task_response":
        // Late response with no pending callback; log and discard
        this.logger.info(`[perkos-a2a] Received unmatched task response: ${msg.id}`);
        break;
      case "discover_response":
        if (this.options.onDiscoverResponse) {
          this.options.onDiscoverResponse(msg.payload.agents as RelayAgentEntry[]);
        }
        break;
      case "heartbeat_ack":
        break;
      case "error":
        this.logger.error(`[perkos-a2a] Relay error: ${msg.payload.code} - ${msg.payload.message}`);
        break;
      default:
        this.logger.info(`[perkos-a2a] Unknown relay message type: ${msg.type}`);
    }
  }

  private send(msg: RelayMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async sendAndWait(
    msg: RelayMessage,
    expectedType: string,
    timeoutMs: number
  ): Promise<RelayMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCallbacks.delete(msg.id);
        reject(new Error(`Relay request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingCallbacks.set(msg.id, (response) => {
        clearTimeout(timer);
        if (response.type === "error") {
          reject(new Error(`Relay error: ${response.payload.message}`));
        } else {
          resolve(response);
        }
      });

      this.send(msg);
    });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const msg: RelayMessage = {
        type: "heartbeat",
        id: randomUUID(),
        from: this.options.agentName,
        payload: {},
        timestamp: new Date().toISOString(),
      };
      this.send(msg);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectMs);
    this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
