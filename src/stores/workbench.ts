import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';

import {
  parseServerMessage,
  type AgentHistory,
  type AgentMessage,
  type AgentState,
  type ClientMessage,
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
  reasoning: string;
  content: string;
  toolCalls: ToolCall[];
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

interface PendingMessageRoute {
  workspaceKey: string;
  agent: string;
}

interface CurrentMessage extends ConversationEntry {
  completed: boolean;
  backendAgentId: string;
}

export const useWorkbenchStore = defineStore('workbench', () => {
  const endpoint = ref(DEFAULT_ENDPOINT);
  const connectionStatus = ref<ConnectionStatus>('offline');
  const connectionError = ref('');
  const workspaces = ref<WorkspaceInfo[]>([]);
  const agentStates = ref<AgentState[]>([]);
  const selectedWorkspaceKey = ref('');
  const selectedAgent = ref<string | null>(null);
  const messages = ref<ConversationEntry[]>([]);
  const currentMessages = ref<Map<string, CurrentMessage>>(new Map());
  const pendingRoutes = reactive(new Map<string, PendingMessageRoute>());
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
    if (selectedAgent.value) return resourceName(selectedAgent.value);
    return selectedWorkspace.value?.manager
      ? resourceName(selectedWorkspace.value.manager)
      : 'Manager';
  });

  const selectedAgentState = computed(() => {
    const workspace = selectedWorkspace.value;
    if (!workspace) return null;
    const agent = selectedAgent.value || workspace.manager;
    return (
      agentStates.value.find(
        (state) =>
          workspaceKey(state.workspace) === workspaceKey(workspace) && state.agent === agent,
      ) ?? null
    );
  });

  const selectedAgentReady = computed(() => selectedAgentState.value?.status === 'ready');
  const selectedAgentWorking = computed(() => {
    if (selectedAgentState.value?.working === true) return true;
    const workspace = selectedWorkspace.value;
    if (!workspace) return false;
    const key = workspaceKey(workspace);
    const agent = selectedAgent.value || workspace.manager;
    return [...pendingRoutes.values()].some(
      (route) => route.workspaceKey === key && route.agent === agent,
    );
  });

  const resourceVisibility = computed(() => {
    const state = selectedAgentState.value;
    if (!state) return [];
    const defaults = new Set(state.default_resources);
    const visible = new Set(state.visible_resources);
    return [...new Set([...defaults, ...visible])].sort().map((resource) => ({
      resource,
      default: defaults.has(resource),
      visible: visible.has(resource),
    }));
  });

  const visibleMessages = computed(() => {
    const workspace = selectedWorkspace.value;
    if (!workspace) return [];

    const routeAgent = selectedAgent.value || workspace.manager;
    const history = messages.value.filter((entry) => {
      if (entry.workspaceKey !== workspaceKey(workspace)) return false;
      if (selectedAgent.value) return entry.agent === selectedAgent.value;
      return workspace.manager ? entry.agent === workspace.manager : true;
    });
    const current = [...currentMessages.value.values()].filter(
      (entry) => entry.workspaceKey === workspaceKey(workspace) && entry.agent === routeAgent,
    );
    return [...history, ...current];
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
    clearCurrentMessages();
    connectionError.value = '';
    connectionStatus.value = 'connecting';

    const nextSocket = new WebSocket(endpoint.value);
    socket = nextSocket;

    nextSocket.onopen = () => {
      if (socket !== nextSocket) return;
      const registration: ClientMessage = {
        type: 'connection.register',
        id: crypto.randomUUID(),
        message: {
          client_type: 'webui',
        },
      };
      nextSocket.send(JSON.stringify(registration));
      reconnectAttempt = 0;
      connectionStatus.value = 'online';
      connectionError.value = '';
    };

    nextSocket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const message = parseServerMessage(event.data);
      if (message) handleServerMessage(message);
    };

    nextSocket.onerror = () => {
      if (socket === nextSocket) connectionError.value = 'Unable to reach the daemon';
    };

    nextSocket.onclose = () => {
      if (socket !== nextSocket) return;
      socket = null;
      connectionStatus.value = 'offline';
      clearCurrentMessages();
      if (shouldReconnect) scheduleReconnect();
    };
    return true;
  }

  function disconnect() {
    shouldReconnect = false;
    clearReconnectTimer();
    closeSocket();
    clearCurrentMessages();
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
    if (!selectedAgentReady.value) {
      connectionError.value = selectedAgentState.value?.error || 'The selected agent is not ready';
      return null;
    }
    if (selectedAgentWorking.value) return null;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      connectionError.value = 'Connect to the daemon before sending a message';
      return null;
    }

    const id = crypto.randomUUID();
    const request: ClientMessage = {
      type: 'agent.message',
      id,
      message: {
        workspace: workspaceReference(workspace),
        agent: selectedAgent.value,
        message: {
          content: text,
        },
      },
    };
    pendingRoutes.set(id, {
      workspaceKey: workspaceKey(workspace),
      agent: selectedAgent.value || workspace.manager,
    });
    socket.send(JSON.stringify(request));
    return id;
  }

  function abortTurn(): string | null {
    const workspace = selectedWorkspace.value;
    if (
      !workspace ||
      !selectedAgentReady.value ||
      !selectedAgentWorking.value ||
      !socket ||
      socket.readyState !== WebSocket.OPEN
    )
      return null;
    const id = crypto.randomUUID();
    const request: ClientMessage = {
      type: 'agent.turn.abort',
      id,
      message: {
        workspace: workspaceReference(workspace),
        agent: selectedAgent.value,
      },
    };
    socket.send(JSON.stringify(request));
    return id;
  }

  function setResourceVisibility(resourceId: ResourceRef, visible: boolean): string | null {
    const workspace = selectedWorkspace.value;
    const state = selectedAgentState.value;
    if (
      !workspace ||
      !selectedAgentReady.value ||
      !state?.default_resources.includes(resourceId) ||
      !socket ||
      socket.readyState !== WebSocket.OPEN
    )
      return null;
    const id = crypto.randomUUID();
    const request: ClientMessage = {
      type: visible ? 'agent.visibility.inject' : 'agent.visibility.remove',
      id,
      message: {
        workspace: workspaceReference(workspace),
        agent: selectedAgent.value,
        resource_id: resourceId,
      },
    };
    socket.send(JSON.stringify(request));
    return id;
  }

  function clearLogs() {
    logs.value = [];
  }

  function handleServerMessage(event: ReturnType<typeof parseServerMessage> & object) {
    if (!event) return;
    switch (event.type) {
      case 'state.sync':
        synchronizeWorkspaces(event.state.workspaces);
        synchronizeAgentStates(event.state.agents);
        synchronizeHistories(event.state.histories);
        reconcileCurrentMessages();
        break;
      case 'workspace.started':
        upsertWorkspace(event.workspace);
        if (!selectedWorkspaceKey.value) selectWorkspace(workspaceKey(event.workspace));
        break;
      case 'workspace.start_failed':
        break;
      case 'agent.message':
        receiveAgentMessage(event.message);
        break;
      case 'agent.message.delta':
        receiveMessageDelta(event);
        break;
      case 'agent.message.reasoning_delta':
        receiveReasoningDelta(event);
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
    removeCurrentMessage(event.id);
    logs.value.push({
      key: `failure-log:${event.id}:${Date.now()}`,
      timestamp: Date.now(),
      level: 'ERROR',
      target: `agent/${event.agent}`,
      message: event.message,
      fields: [{ name: 'kind', value: event.kind }],
    });
  }

  function receiveMessageDelta(event: { id: string; agent: string; content: string }) {
    const route = resolveMessageRoute(event.id, event.agent);
    if (!route || !routeIsWorking(route)) return;
    const existing = currentMessages.value.get(event.id);
    if (existing?.completed) return;
    if (existing?.backendAgentId && existing.backendAgentId !== event.agent) return;

    const next: CurrentMessage = existing
      ? { ...existing, content: existing.content + event.content, backendAgentId: event.agent }
      : {
          key: `current:${event.id}`,
          id: event.id,
          sequence: Number.MAX_SAFE_INTEGER,
          workspaceKey: route.workspaceKey,
          agent: route.agent,
          role: 'assistant',
          reasoning: '',
          content: event.content,
          toolCalls: [],
          timestamp: Date.now(),
          completed: false,
          backendAgentId: event.agent,
        };
    replaceCurrentMessage(event.id, next);
  }

  function receiveReasoningDelta(event: { id: string; agent: string; content: string }) {
    const route = resolveMessageRoute(event.id, event.agent);
    if (!route || !routeIsWorking(route)) return;
    const existing = currentMessages.value.get(event.id);
    if (existing?.completed) return;
    if (existing?.backendAgentId && existing.backendAgentId !== event.agent) return;

    const next: CurrentMessage = existing
      ? {
          ...existing,
          reasoning: existing.reasoning + event.content,
          backendAgentId: event.agent,
        }
      : {
          key: `current:${event.id}`,
          id: event.id,
          sequence: Number.MAX_SAFE_INTEGER,
          workspaceKey: route.workspaceKey,
          agent: route.agent,
          role: 'assistant',
          reasoning: event.content,
          content: '',
          toolCalls: [],
          timestamp: Date.now(),
          completed: false,
          backendAgentId: event.agent,
        };
    replaceCurrentMessage(event.id, next);
  }

  function receiveAgentMessage(event: {
    id: string;
    workspace: WorkspaceRef;
    agent: string;
    message: AgentMessage;
  }) {
    if (!('Assistant' in event.message)) return;
    const route = pendingRoutes.get(event.id) ?? {
      workspaceKey: workspaceKey(event.workspace),
      agent: event.agent,
    };
    const existing = currentMessages.value.get(event.id);
    const next: CurrentMessage = {
      key: `current:${event.id}`,
      id: event.id,
      sequence: Number.MAX_SAFE_INTEGER,
      workspaceKey: route.workspaceKey,
      agent: route.agent,
      role: 'assistant',
      reasoning: event.message.Assistant.reasoning ?? '',
      content: event.message.Assistant.content ?? '',
      toolCalls: event.message.Assistant.tool_calls,
      timestamp: existing?.timestamp ?? Date.now(),
      completed: true,
      backendAgentId: existing?.backendAgentId ?? '',
    };
    pendingRoutes.set(event.id, route);
    replaceCurrentMessage(event.id, next);
    reconcileCurrentMessages();
  }

  function reconcileCurrentMessages() {
    for (const [id, current] of currentMessages.value) {
      const state = agentStates.value.find(
        (candidate) =>
          workspaceKey(candidate.workspace) === current.workspaceKey &&
          candidate.agent === current.agent,
      );
      if (!current.completed && state?.status === 'ready' && !state.working) {
        removeCurrentMessage(id);
        continue;
      }
      if (!current.completed) continue;
      const persisted = messages.value.some(
        (message) =>
          message.id === id &&
          message.workspaceKey === current.workspaceKey &&
          message.agent === current.agent &&
          message.role === 'assistant' &&
          message.reasoning === current.reasoning &&
          message.content === current.content &&
          sameToolCalls(message.toolCalls, current.toolCalls),
      );
      if (persisted) removeCurrentMessage(id);
    }
    for (const [id, route] of pendingRoutes) {
      if (currentMessages.value.has(id)) continue;
      const state = agentStates.value.find(
        (candidate) =>
          workspaceKey(candidate.workspace) === route.workspaceKey && candidate.agent === route.agent,
      );
      if (state?.status === 'ready' && !state.working) pendingRoutes.delete(id);
    }
  }

  function replaceCurrentMessage(id: string, message: CurrentMessage) {
    const next = new Map(currentMessages.value);
    next.set(id, message);
    currentMessages.value = next;
  }

  function resolveMessageRoute(id: string, agent: string): PendingMessageRoute | undefined {
    return (
      pendingRoutes.get(id) ??
      messages.value.find((message) => message.id === id && message.agent === agent)
    );
  }

  function routeIsWorking(route: PendingMessageRoute): boolean {
    return agentStates.value.some(
      (state) =>
        workspaceKey(state.workspace) === route.workspaceKey &&
        state.agent === route.agent &&
        state.status === 'ready' &&
        state.working,
    );
  }

  function removeCurrentMessage(id: string) {
    pendingRoutes.delete(id);
    if (!currentMessages.value.has(id)) return;
    const next = new Map(currentMessages.value);
    next.delete(id);
    currentMessages.value = next;
  }

  function clearCurrentMessages() {
    pendingRoutes.clear();
    currentMessages.value = new Map();
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
          reasoning: decoded.reasoning,
          content: decoded.content,
          toolCalls: decoded.toolCalls,
          timestamp: entry.created_at_ms,
        };
      }),
    );
  }

  function synchronizeAgentStates(snapshot: AgentState[]) {
    agentStates.value = snapshot.map((state) => ({
      workspace: { ...state.workspace },
      agent: state.agent,
      status: state.status,
      working: state.working === true,
      error: state.error ?? null,
      default_resources: [...(state.default_resources ?? [])],
      visible_resources: [...state.visible_resources],
      mcl: state.mcl
        ? {
            ...state.mcl,
            workflows: state.mcl.workflows.map((workflow) => ({ ...workflow })),
          }
        : null,
      total_input_tokens: state.total_input_tokens ?? 0,
      total_output_tokens: state.total_output_tokens ?? 0,
      total_cache_hit_tokens: state.total_cache_hit_tokens ?? 0,
      cache_hit_rate: state.cache_hit_rate ?? 0,
      last_input_tokens: state.last_input_tokens ?? 0,
      context_window_tokens: state.context_window_tokens ?? 0,
    }));
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
    agentStates,
    selectedWorkspaceKey,
    selectedWorkspace,
    selectedAgent,
    selectedAgentName,
    selectedAgentState,
    selectedAgentReady,
    selectedAgentWorking,
    resourceVisibility,
    visibleMessages,
    logs,
    connect,
    disconnect,
    selectWorkspace,
    selectAgent,
    sendMessage,
    abortTurn,
    setResourceVisibility,
    clearLogs,
  };
});

export function workspaceKey(workspace: WorkspaceRef): string {
  return `${workspace.project_root}\u0000${workspace.name}`;
}

export function resourceName(resource: string): string {
  const identity = resource.includes(':') ? resource.slice(resource.indexOf(':') + 1) : resource;
  const withoutTag = identity.includes(':') ? identity.slice(0, identity.lastIndexOf(':')) : identity;
  return withoutTag.includes('/') ? withoutTag.slice(withoutTag.lastIndexOf('/') + 1) : withoutTag;
}

function workspaceReference(workspace: WorkspaceInfo): WorkspaceRef {
  return { id: workspace.id, name: workspace.name, project_root: workspace.project_root };
}

function decodeMessage(message: AgentMessage): {
  role: MessageRole;
  reasoning: string;
  content: string;
  toolCalls: ToolCall[];
} {
  if ('User' in message) {
    return {
      role: 'user',
      reasoning: '',
      content: message.User.content,
      toolCalls: [],
    };
  }
  if ('Assistant' in message) {
    return {
      role: 'assistant',
      reasoning: message.Assistant.reasoning ?? '',
      content: message.Assistant.content ?? '',
      toolCalls: message.Assistant.tool_calls,
    };
  }
  return {
    role: 'tool',
    reasoning: '',
    content: message.Tool.content,
    toolCalls: [],
  };
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

function sameToolCalls(left: ToolCall[], right: ToolCall[]): boolean {
  return (
    left.length === right.length &&
    left.every((call, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        call.id === candidate.id &&
        call.tool_name === candidate.tool_name &&
        call.arguments === candidate.arguments
      );
    })
  );
}

function normalizeWorkspace(workspace: WorkspaceInfo): WorkspaceInfo {
  const normalized: WorkspaceInfo = {
    id: workspace.id || `workspace:local/${workspace.name}:latest`,
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
