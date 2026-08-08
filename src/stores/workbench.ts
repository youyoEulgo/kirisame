import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import {
  parseServerEvent,
  type AgentHistory,
  type AgentMessage,
  type ClientRequest,
  type ResourceRef,
  type ToolCall,
  type WorkspaceInfo,
  type WorkspaceRef,
} from '@/types/protocol';

const DEFAULT_ENDPOINT = 'ws://127.0.0.1:3939/ws';
const MAX_LOGS = 500;

export type ConnectionStatus = 'offline' | 'connecting' | 'online';
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ConversationEntry {
  key: string;
  id: string;
  sequence: number;
  workspaceKey: string;
  agent: string;
  role: MessageRole;
  content: string;
  toolCalls: ToolCall[];
  resources: ResourceRef[];
  timestamp: number;
}

export interface RuntimeLog {
  key: string;
  timestamp: number;
  level: string;
  target: string;
  message: string;
  fields: Array<{ name: string; value: string }>;
}

export const useWorkbenchStore = defineStore('workbench', () => {
  const endpoint = ref(DEFAULT_ENDPOINT);
  const connectionStatus = ref<ConnectionStatus>('offline');
  const connectionError = ref('');
  const workspaces = ref<WorkspaceInfo[]>([]);
  const selectedWorkspaceKey = ref('');
  const selectedAgent = ref<string | null>(null);
  const messages = ref<ConversationEntry[]>([]);
  const logs = ref<RuntimeLog[]>([]);

  let socket: WebSocket | null = null;
  let reconnectTimer: number | undefined;
  let reconnectAttempt = 0;
  let shouldReconnect = true;

  const selectedWorkspace = computed(
    () =>
      workspaces.value.find(
        (workspace) => workspaceKey(workspace) === selectedWorkspaceKey.value,
      ) ?? null,
  );

  const selectedAgentName = computed(() => {
    if (selectedAgent.value) return selectedAgent.value;
    return selectedWorkspace.value?.manager || 'Manager';
  });

  const visibleMessages = computed(() => {
    const workspace = selectedWorkspace.value;
    if (!workspace) return [];

    return messages.value.filter((entry) => {
      if (entry.workspaceKey !== workspaceKey(workspace)) return false;
      if (selectedAgent.value) return entry.agent === selectedAgent.value;
      return workspace.manager ? entry.agent === workspace.manager : true;
    });
  });

  function connect(nextEndpoint?: string): boolean {
    if (nextEndpoint !== undefined) {
      try {
        endpoint.value = normalizeEndpoint(nextEndpoint);
      } catch (error) {
        connectionError.value = error instanceof Error ? error.message : String(error);
        return false;
      }
    }

    shouldReconnect = true;
    clearReconnectTimer();
    closeSocket();
    connectionError.value = '';
    connectionStatus.value = 'connecting';

    const nextSocket = new WebSocket(endpoint.value);
    socket = nextSocket;

    nextSocket.onopen = () => {
      if (socket !== nextSocket) return;
      const registration: ClientRequest = {
        type: 'connection.register',
        client_type: 'webui',
      };
      nextSocket.send(JSON.stringify(registration));
      reconnectAttempt = 0;
      connectionStatus.value = 'online';
      connectionError.value = '';
    };

    nextSocket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const message = parseServerEvent(event.data);
      if (message) handleServerEvent(message);
    };

    nextSocket.onerror = () => {
      if (socket === nextSocket) connectionError.value = 'Unable to reach the daemon';
    };

    nextSocket.onclose = () => {
      if (socket !== nextSocket) return;
      socket = null;
      connectionStatus.value = 'offline';
      if (shouldReconnect) scheduleReconnect();
    };
    return true;
  }

  function disconnect() {
    shouldReconnect = false;
    clearReconnectTimer();
    closeSocket();
    connectionStatus.value = 'offline';
  }

  function selectWorkspace(key: string) {
    selectedWorkspaceKey.value = key;
    selectedAgent.value = null;
  }

  function selectAgent(agent: string | null) {
    selectedAgent.value = agent;
  }

  function sendMessage(content: string): string | null {
    const workspace = selectedWorkspace.value;
    const text = content.trim();
    if (!workspace || !text) return null;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      connectionError.value = 'Connect to the daemon before sending a message';
      return null;
    }

    const id = crypto.randomUUID();
    const request: ClientRequest = {
      type: 'agent.message',
      id,
      workspace: workspaceReference(workspace),
      agent: selectedAgent.value,
      content: text,
    };
    socket.send(JSON.stringify(request));
    return id;
  }

  function clearLogs() {
    logs.value = [];
  }

  function handleServerEvent(event: ReturnType<typeof parseServerEvent> & object) {
    if (!event) return;
    switch (event.type) {
      case 'state.sync':
        synchronizeWorkspaces(event.state.workspaces);
        synchronizeHistories(event.state.histories);
        break;
      case 'workspace.started':
        upsertWorkspace(event.workspace);
        if (!selectedWorkspaceKey.value) selectWorkspace(workspaceKey(event.workspace));
        break;
      case 'agent.message':
        break;
      case 'agent.failure':
        receiveFailure(event.failure);
        break;
      case 'log':
        logs.value.push({
          key: `log:${event.record.timestamp_millis}:${logs.value.length}`,
          timestamp: event.record.timestamp_millis,
          level: event.record.level,
          target: event.record.target,
          message: event.record.message,
          fields: event.record.fields,
        });
        if (logs.value.length > MAX_LOGS) logs.value.splice(0, logs.value.length - MAX_LOGS);
        break;
    }
  }

  function receiveFailure(event: {
    id: string;
    workspace: WorkspaceRef;
    agent: string;
    kind: string;
    message: string;
  }) {
    logs.value.push({
      key: `failure-log:${event.id}:${Date.now()}`,
      timestamp: Date.now(),
      level: 'ERROR',
      target: `agent/${event.agent}`,
      message: event.message,
      fields: [{ name: 'kind', value: event.kind }],
    });
  }

  function upsertWorkspace(workspace: WorkspaceInfo) {
    const key = workspaceKey(workspace);
    const index = workspaces.value.findIndex((candidate) => workspaceKey(candidate) === key);
    const normalized = normalizeWorkspace(workspace);
    if (index === -1) workspaces.value.push(normalized);
    else workspaces.value[index] = normalized;
  }

  function synchronizeWorkspaces(snapshot: WorkspaceInfo[]) {
    const next = snapshot
      .map(normalizeWorkspace)
      .filter((workspace) => workspace.name && workspace.project_root);
    if (sameWorkspaceList(workspaces.value, next)) return;

    workspaces.value = next;
    if (!next.some((workspace) => workspaceKey(workspace) === selectedWorkspaceKey.value)) {
      selectedWorkspaceKey.value = next[0] ? workspaceKey(next[0]) : '';
      selectedAgent.value = null;
    } else if (
      selectedAgent.value &&
      !selectedWorkspace.value?.agents.includes(selectedAgent.value)
    ) {
      selectedAgent.value = null;
    }
  }

  function synchronizeHistories(histories: AgentHistory[]) {
    messages.value = histories.flatMap((history) =>
      history.messages.map((entry) => {
        const decoded = decodeMessage(entry.message);
        return {
          key: `history:${workspaceKey(history.workspace)}:${history.agent}:${entry.sequence}`,
          id: entry.turn_id,
          sequence: entry.sequence,
          workspaceKey: workspaceKey(history.workspace),
          agent: history.agent,
          role: decoded.role,
          content: decoded.content,
          toolCalls: decoded.toolCalls,
          resources: entry.resources,
          timestamp: entry.created_at_ms,
        };
      }),
    );
  }

  function scheduleReconnect() {
    clearReconnectTimer();
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 10_000);
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => connect(), delay);
  }

  function clearReconnectTimer() {
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  function closeSocket() {
    if (!socket) return;
    const current = socket;
    socket = null;
    current.onclose = null;
    current.close();
  }

  return {
    endpoint,
    connectionStatus,
    connectionError,
    workspaces,
    selectedWorkspaceKey,
    selectedWorkspace,
    selectedAgent,
    selectedAgentName,
    visibleMessages,
    logs,
    connect,
    disconnect,
    selectWorkspace,
    selectAgent,
    sendMessage,
    clearLogs,
  };
});

export function workspaceKey(workspace: WorkspaceRef): string {
  return `${workspace.project_root}\u0000${workspace.name}`;
}

function workspaceReference(workspace: WorkspaceInfo): WorkspaceRef {
  return { name: workspace.name, project_root: workspace.project_root };
}

function decodeMessage(message: AgentMessage): {
  role: MessageRole;
  content: string;
  toolCalls: ToolCall[];
} {
  if ('User' in message) return { role: 'user', content: message.User.content, toolCalls: [] };
  if ('System' in message)
    return { role: 'system', content: message.System.content, toolCalls: [] };
  if ('Tool' in message) return { role: 'tool', content: message.Tool.content, toolCalls: [] };
  return {
    role: 'assistant',
    content: message.Assistant.content ?? '',
    toolCalls: message.Assistant.tool_calls,
  };
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

function normalizeWorkspace(workspace: WorkspaceInfo): WorkspaceInfo {
  const normalized: WorkspaceInfo = {
    name: workspace.name.trim(),
    project_root: workspace.project_root.trim(),
    manager: workspace.manager.trim(),
    agents: uniqueNames(workspace.agents),
  };
  if (normalized.manager && !normalized.agents.includes(normalized.manager)) {
    normalized.agents.unshift(normalized.manager);
  }
  return normalized;
}

function sameWorkspaceList(left: WorkspaceInfo[], right: WorkspaceInfo[]): boolean {
  return (
    left.length === right.length &&
    left.every((workspace, index) => {
      const candidate = right[index];
      return (
        candidate &&
        workspaceKey(workspace) === workspaceKey(candidate) &&
        workspace.manager === candidate.manager &&
        workspace.agents.length === candidate.agents.length &&
        workspace.agents.every((agent, agentIndex) => agent === candidate.agents[agentIndex])
      );
    })
  );
}

function normalizeEndpoint(raw: string): string {
  let value = raw.trim();
  if (!value) throw new Error('Daemon URL is required');
  if (!value.includes('://')) value = `ws://${value}`;
  const url = new URL(value);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('Daemon URL must use ws:// or wss://');
  }
  if (url.pathname === '/') url.pathname = '/ws';
  return url.toString();
}
