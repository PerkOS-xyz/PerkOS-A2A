/** A2A Protocol types (v0.3.0) */

export interface AgentCard {
  name: string;
  description: string;
  protocolVersion: string;
  version: string;
  url: string;
  skills: AgentSkill[];
  capabilities: { pushNotifications: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface Part {
  kind: "text" | "file" | "data";
  text?: string;
  mimeType?: string;
  data?: unknown;
}

export interface Message {
  kind: "message";
  messageId: string;
  role: "user" | "agent";
  parts: Part[];
  contextId?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskStatus {
  state: "submitted" | "working" | "completed" | "failed" | "canceled";
  timestamp: string;
  message?: Partial<Message>;
}

export interface Artifact {
  kind: "artifact";
  artifactId: string;
  parts: Part[];
}

export interface Task {
  kind: "task";
  id: string;
  contextId: string;
  status: TaskStatus;
  messages: Message[];
  artifacts: Artifact[];
  metadata?: Record<string, unknown>;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
  id: string;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface PeerConfig {
  [agentName: string]: string;
}

export interface RelayConfig {
  /** WebSocket URL of the relay hub (e.g. wss://relay.perkos.xyz) */
  url: string;
  /** API key for authenticating with the relay hub */
  apiKey: string;
  /** Whether relay connectivity is enabled */
  enabled: boolean;
}

export interface AuthConfig {
  /** Require API key for inbound HTTP requests */
  requireApiKey: boolean;
  /** Accepted API keys for inbound HTTP requests */
  apiKeys: string[];
}

export interface A2APluginConfig {
  agentName: string;
  port: number;
  skills: AgentSkill[];
  peers: PeerConfig;
  mode?: "full" | "client-only" | "relay" | "auto";
  relay?: RelayConfig;
  auth?: AuthConfig;
}

/** Wire protocol for relay WebSocket messages */
export type RelayMessageType =
  | "register"
  | "register_ack"
  | "task"
  | "task_response"
  | "discover"
  | "discover_response"
  | "heartbeat"
  | "heartbeat_ack"
  | "error";

export interface RelayMessage {
  type: RelayMessageType;
  /** Sender agent name */
  from?: string;
  /** Target agent name (for routed messages) */
  to?: string;
  /** Unique message identifier */
  id: string;
  /** Message payload */
  payload: Record<string, unknown>;
  /** ISO timestamp */
  timestamp: string;
}

export interface RelayAgentEntry {
  name: string;
  connectedAt: string;
  lastHeartbeat: string;
  card?: AgentCard;
}
