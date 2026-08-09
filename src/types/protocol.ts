export interface WorkspaceRef {
  name: string;
  project_root: string;
}

export interface WorkspaceInfo extends WorkspaceRef {
  manager: string;
  agents: string[];
}

export interface ResourceRef {
  provider: string;
  name: string;
}

export interface HistoryMessage {
  sequence: number;
  turn_id: string;
  message: AgentMessage;
  resources: ResourceRef[];
  created_at_ms: number;
}

export interface AgentHistory {
  workspace: WorkspaceRef;
  agent: string;
  messages: HistoryMessage[];
}

export interface BackendState {
  workspaces: WorkspaceInfo[];
  histories: AgentHistory[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type AgentMessage =
  { User: { content: string } } | { Assistant: { content: string | null; tool_calls: ToolCall[] } };

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

export type ClientMessage =
  | {
      type: 'connection.register';
      id: string;
      message: {
        client_type: string;
      };
    }
  | {
      type: 'agent.message';
      id: string;
      message: {
        workspace: WorkspaceRef;
        agent: string | null;
        message: {
          content: string;
        };
      };
    };

export type ServerMessage =
  | { type: 'log'; record: LogRecord }
  | { type: 'state.sync'; state: BackendState }
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

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.type !== 'string') return null;

    switch (value.type) {
      case 'log':
        return isRecord(value.record) ? (value as ServerMessage) : null;
      case 'state.sync':
        if (!isRecord(value.state) || !Array.isArray(value.state.workspaces)) return null;
        return {
          type: 'state.sync',
          state: {
            workspaces: value.state.workspaces as WorkspaceInfo[],
            histories: Array.isArray(value.state.histories)
              ? (value.state.histories as AgentHistory[])
              : [],
          },
        };
      case 'workspace.started':
        return isRecord(value.workspace) ? (value as ServerMessage) : null;
      case 'agent.message':
        return isRecord(value.message) ? (value as ServerMessage) : null;
      case 'agent.failure':
        return isRecord(value.failure) ? (value as ServerMessage) : null;
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
