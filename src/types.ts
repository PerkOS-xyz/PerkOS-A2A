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

export interface A2APluginConfig {
  agentName: string;
  port: number;
  skills: AgentSkill[];
  peers: PeerConfig;
  mode?: "full" | "client-only" | "auto";
}
