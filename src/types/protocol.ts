export interface WorkspaceRef {
  id: string;
  name: string;
  project_root: string;
}

export interface WorkspaceInfo extends WorkspaceRef {
  manager: string;
  agents: string[];
}

export type ResourceRef = string;
export type AgentStatus = 'creating' | 'ready' | 'failed';

export interface AgentState {
  workspace: WorkspaceRef;
  agent: string;
  status: AgentStatus;
  working: boolean;
  error: string | null;
  default_resources: ResourceRef[];
  visible_resources: ResourceRef[];
  loading_skills: ResourceRef[];
}

export interface HistoryMessage {
  sequence: number;
  turn_id: string;
  message: AgentMessage;
  created_at_ms: number;
}

export interface AgentHistory {
  workspace: WorkspaceRef;
  agent: string;
  messages: HistoryMessage[];
}

export interface BackendState {
  workspaces: WorkspaceInfo[];
  agents: AgentState[];
  histories: AgentHistory[];
}

export interface ToolCall {
  id: string;
  tool_name: string;
  arguments: string;
}

export type AgentMessage =
  | { User: { content: string; tool_calls: ToolCall[] } }
  | { Assistant: { reasoning: string | null; content: string | null; tool_calls: ToolCall[] } }
  | { Tool: { resource_id: ResourceRef; tool_call_id: string; content: string } };

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
    }
  | {
      type: 'agent.turn.abort';
      id: string;
      message: {
        workspace: WorkspaceRef;
        agent: string | null;
      };
    }
  | {
      type: 'agent.skill.load' | 'agent.skill.unload';
      id: string;
      message: {
        workspace: WorkspaceRef;
        agent: string | null;
        resource_id: ResourceRef;
      };
    }
  | {
      type: 'agent.skill.unload_all';
      id: string;
      message: {
        workspace: WorkspaceRef;
        agent: string | null;
      };
    }
  | {
      type: 'agent.visibility.inject' | 'agent.visibility.remove';
      id: string;
      message: {
        workspace: WorkspaceRef;
        agent: string | null;
        resource_id: ResourceRef;
      };
    };

export type ServerMessage =
  | { type: 'log'; record: LogRecord }
  | { type: 'state.sync'; state: BackendState }
  | { type: 'workspace.started'; id: string; workspace: WorkspaceInfo }
  | { type: 'workspace.start_failed'; id: string; error: string }
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
      type: 'agent.message.delta';
      id: string;
      agent: string;
      content: string;
    }
  | {
      type: 'agent.message.reasoning_delta';
      id: string;
      agent: string;
      content: string;
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
            agents: Array.isArray(value.state.agents) ? (value.state.agents as AgentState[]) : [],
            histories: Array.isArray(value.state.histories)
              ? (value.state.histories as AgentHistory[])
              : [],
          },
        };
      case 'workspace.started':
        return isRecord(value.workspace) ? (value as ServerMessage) : null;
      case 'workspace.start_failed':
        return typeof value.id === 'string' && typeof value.error === 'string'
          ? (value as ServerMessage)
          : null;
      case 'agent.message':
        return isRecord(value.message) ? (value as ServerMessage) : null;
      case 'agent.message.delta':
      case 'agent.message.reasoning_delta':
        return typeof value.id === 'string' &&
          typeof value.agent === 'string' &&
          typeof value.content === 'string'
          ? (value as ServerMessage)
          : null;
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
