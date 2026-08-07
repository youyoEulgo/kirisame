export interface WorkspaceRef {
  name: string;
  project_root: string;
}

export interface WorkspaceInfo extends WorkspaceRef {
  manager: string;
  agents: string[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type AgentMessage =
  | { System: { content: string } }
  | { User: { content: string } }
  | { Assistant: { content: string | null; tool_calls: ToolCall[] } }
  | { Tool: { tool_call_id: string; content: string } };

export interface LogField {
  name: string;
  value: string;
}

export interface LogRecord {
  timestamp_millis: number;
  level: string;
  target: string;
  message: string;
  fields: LogField[];
  spans: string[];
}

export type ClientRequest = {
  type: 'agent.message';
  id: string;
  workspace: WorkspaceRef;
  agent: string | null;
  content: string;
};

export type ServerEvent =
  | { type: 'log'; record: LogRecord }
  | { type: 'workspace.started'; id: string; workspace: WorkspaceInfo }
  | {
    type: 'agent.message';
    message: {
      id: string;
      workspace: WorkspaceRef;
      agent: string;
      message: AgentMessage;
    };
  }
  | {
    type: 'agent.failure';
    failure: {
      id: string;
      workspace: WorkspaceRef;
      agent: string;
      kind: string;
      message: string;
    };
  };

export function parseServerEvent(raw: string): ServerEvent | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.type !== 'string') return null;

    switch (value.type) {
      case 'log':
        return isRecord(value.record) ? (value as ServerEvent) : null;
      case 'workspace.started':
        return isRecord(value.workspace) ? (value as ServerEvent) : null;
      case 'agent.message':
        return isRecord(value.message) ? (value as ServerEvent) : null;
      case 'agent.failure':
        return isRecord(value.failure) ? (value as ServerEvent) : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
