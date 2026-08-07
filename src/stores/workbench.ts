import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';

import {
  parseServerEvent,
  type AgentMessage,
  type ClientRequest,
  type ToolCall,
  type WorkspaceInfo,
  type WorkspaceRef,
} from '@/types/protocol';

const STORAGE_KEY = 'margatroid.ui.v1';
const DEFAULT_ENDPOINT = 'ws://127.0.0.1:3939/ws';
const MAX_LOGS = 500;
const MAX_MESSAGES = 300;

export type ConnectionStatus = 'offline' | 'connecting' | 'online';
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool' | 'failure';
export type DeliveryState = 'pending' | 'sent' | 'failed';

export interface ConversationEntry {
  key: string;
  id: string;
  workspaceKey: string;
  agent: string;
  requestedAgent: string | null;
  role: MessageRole;
  content: string;
  toolCalls: ToolCall[];
  timestamp: number;
  delivery: DeliveryState;
}

export interface RuntimeLog {
  key: string;
  timestamp: number;
  level: string;
  target: string;
  message: string;
  fields: Array<{ name: string; value: string }>;
}

interface PersistedState {
  endpoint: string;
  workspaces: WorkspaceInfo[];
  selectedWorkspaceKey: string;
  messages: ConversationEntry[];
}

export const useWorkbenchStore = defineStore('workbench', () => {
  const persisted = loadState();
  const endpoint = ref(persisted.endpoint);
  const connectionStatus = ref<ConnectionStatus>('offline');
  const connectionError = ref('');
  const workspaces = ref<WorkspaceInfo[]>(persisted.workspaces);
  const selectedWorkspaceKey = ref(persisted.selectedWorkspaceKey);
  const selectedAgent = ref<string | null>(null);
  const messages = ref<ConversationEntry[]>(persisted.messages);
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

  const selectedAgentBusy = computed(() =>
    visibleMessages.value.some((entry) => entry.role === 'user' && entry.delivery === 'pending'),
  );

  watch(
    [endpoint, workspaces, selectedWorkspaceKey, messages],
    () => {
      saveState({
        endpoint: endpoint.value,
        workspaces: workspaces.value,
        selectedWorkspaceKey: selectedWorkspaceKey.value,
        messages: messages.value.slice(-MAX_MESSAGES),
      });
    },
    { deep: true },
  );

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
      markPendingMessagesFailed();
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

  function addWorkspace(workspace: WorkspaceInfo) {
    const normalized: WorkspaceInfo = {
      name: workspace.name.trim(),
      project_root: workspace.project_root.trim(),
      manager: workspace.manager.trim(),
      agents: uniqueNames(workspace.agents),
    };
    if (!normalized.name) throw new Error('Workspace name is required');
    if (!normalized.project_root) throw new Error('Project root is required');
    if (normalized.manager && !normalized.agents.includes(normalized.manager)) {
      normalized.agents.unshift(normalized.manager);
    }
    upsertWorkspace(normalized);
    selectWorkspace(workspaceKey(normalized));
  }

  function removeWorkspace(key: string) {
    workspaces.value = workspaces.value.filter((workspace) => workspaceKey(workspace) !== key);
    messages.value = messages.value.filter((entry) => entry.workspaceKey !== key);
    if (selectedWorkspaceKey.value === key) {
      selectedWorkspaceKey.value = workspaces.value[0] ? workspaceKey(workspaces.value[0]) : '';
      selectedAgent.value = null;
    }
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
    const target = selectedAgent.value || workspace.manager || 'Manager';

    messages.value.push({
      key: `local:${id}`,
      id,
      workspaceKey: workspaceKey(workspace),
      agent: target,
      requestedAgent: selectedAgent.value,
      role: 'user',
      content: text,
      toolCalls: [],
      timestamp: Date.now(),
      delivery: 'pending',
    });
    trimMessages();
    socket.send(JSON.stringify(request));

    window.setTimeout(() => {
      const pending = messages.value.find(
        (entry) => entry.id === id && entry.delivery === 'pending',
      );
      if (pending) pending.delivery = 'failed';
    }, 12_000);
    return id;
  }

  function clearConversation() {
    const workspace = selectedWorkspace.value;
    if (!workspace) return;
    const key = workspaceKey(workspace);
    const agent = selectedAgent.value || workspace.manager;
    messages.value = messages.value.filter(
      (entry) => entry.workspaceKey !== key || (agent ? entry.agent !== agent : false),
    );
  }

  function clearLogs() {
    logs.value = [];
  }

  function handleServerEvent(event: ReturnType<typeof parseServerEvent> & object) {
    if (!event) return;
    switch (event.type) {
      case 'workspace.started':
        upsertWorkspace(event.workspace);
        if (!selectedWorkspaceKey.value) selectWorkspace(workspaceKey(event.workspace));
        break;
      case 'agent.message':
        receiveAgentMessage(event.message);
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

  function receiveAgentMessage(event: {
    id: string;
    workspace: WorkspaceRef;
    agent: string;
    message: AgentMessage;
  }) {
    const key = workspaceKey(event.workspace);
    const decoded = decodeMessage(event.message);
    const pending = messages.value.find(
      (entry) =>
        entry.workspaceKey === key &&
        entry.id === event.id &&
        entry.role === 'user' &&
        entry.delivery === 'pending',
    );

    if (decoded.role === 'user' && pending) {
      pending.agent = event.agent;
      pending.delivery = 'sent';
      if (pending.requestedAgent === null) learnManager(event.workspace, event.agent);
      return;
    }

    ensureWorkspaceAgent(event.workspace, event.agent);
    messages.value.push({
      key: `remote:${event.id}:${decoded.role}:${Date.now()}:${messages.value.length}`,
      id: event.id,
      workspaceKey: key,
      agent: event.agent,
      requestedAgent: event.agent,
      role: decoded.role,
      content: decoded.content,
      toolCalls: decoded.toolCalls,
      timestamp: Date.now(),
      delivery: 'sent',
    });
    trimMessages();
  }

  function receiveFailure(event: {
    id: string;
    workspace: WorkspaceRef;
    agent: string;
    kind: string;
    message: string;
  }) {
    ensureWorkspaceAgent(event.workspace, event.agent);
    messages.value.push({
      key: `failure:${event.id}:${Date.now()}`,
      id: event.id,
      workspaceKey: workspaceKey(event.workspace),
      agent: event.agent,
      requestedAgent: event.agent,
      role: 'failure',
      content: event.message,
      toolCalls: [],
      timestamp: Date.now(),
      delivery: 'failed',
    });
    logs.value.push({
      key: `failure-log:${event.id}:${Date.now()}`,
      timestamp: Date.now(),
      level: 'ERROR',
      target: `agent/${event.agent}`,
      message: event.message,
      fields: [{ name: 'kind', value: event.kind }],
    });
    trimMessages();
  }

  function upsertWorkspace(workspace: WorkspaceInfo) {
    const key = workspaceKey(workspace);
    const index = workspaces.value.findIndex((candidate) => workspaceKey(candidate) === key);
    const normalized = { ...workspace, agents: uniqueNames(workspace.agents) };
    if (index === -1) workspaces.value.push(normalized);
    else workspaces.value[index] = normalized;
  }

  function ensureWorkspaceAgent(workspace: WorkspaceRef, agent: string) {
    const key = workspaceKey(workspace);
    const current = workspaces.value.find((candidate) => workspaceKey(candidate) === key);
    if (!current) {
      workspaces.value.push({ ...workspace, manager: '', agents: [agent] });
      if (!selectedWorkspaceKey.value) selectWorkspace(key);
      return;
    }
    if (!current.agents.includes(agent)) current.agents.push(agent);
  }

  function learnManager(workspace: WorkspaceRef, agent: string) {
    ensureWorkspaceAgent(workspace, agent);
    const current = workspaces.value.find(
      (candidate) => workspaceKey(candidate) === workspaceKey(workspace),
    );
    if (current && !current.manager) current.manager = agent;
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

  function markPendingMessagesFailed() {
    for (const message of messages.value) {
      if (message.delivery === 'pending') message.delivery = 'failed';
    }
  }

  function trimMessages() {
    if (messages.value.length > MAX_MESSAGES) {
      messages.value.splice(0, messages.value.length - MAX_MESSAGES);
    }
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
    selectedAgentBusy,
    visibleMessages,
    logs,
    connect,
    disconnect,
    addWorkspace,
    removeWorkspace,
    selectWorkspace,
    selectAgent,
    sendMessage,
    clearConversation,
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

function loadState(): PersistedState {
  const fallback: PersistedState = {
    endpoint: DEFAULT_ENDPOINT,
    workspaces: [],
    selectedWorkspaceKey: '',
    messages: [],
  };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<PersistedState>;
    return {
      endpoint: typeof value.endpoint === 'string' ? value.endpoint : fallback.endpoint,
      workspaces: Array.isArray(value.workspaces) ? value.workspaces : [],
      selectedWorkspaceKey:
        typeof value.selectedWorkspaceKey === 'string' ? value.selectedWorkspaceKey : '',
      messages: Array.isArray(value.messages) ? value.messages : [],
    };
  } catch {
    return fallback;
  }
}

function saveState(state: PersistedState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage is optional; the live WebSocket session remains usable.
  }
}
