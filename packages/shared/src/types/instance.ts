export type AgentType = 'opencode' | 'claude-code';

export type InstanceStatus = 'connected' | 'disconnected' | 'error';

export interface Instance {
  id: string;
  name: string;
  type: AgentType;
  url: string | null;
  version: string | null;
  mcpServerVersion: string | null;
  status: InstanceStatus;
  lastSeen: string;
  createdAt: string;
}

export interface InstanceListResponse {
  instances: Instance[];
}
