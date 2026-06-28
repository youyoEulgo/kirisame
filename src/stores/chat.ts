import { ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { sendToWorkspace, fetchWorkspaces, replyToHumanRequest } from '@/api/workspace';

export interface DisplayMessage {
  role: string;
  brief: string;
  detail: string;
}

export interface InboxItem {
  session_id: string;
  from: string;
  to: string;
  brief: string;
  detail: string;
}

// ── Workspace Event Types ────────────────────────────────

interface EventMetadata {
  event: string;
  member_id: string;
  delegation_id: string;
  timestamp: number;
}

interface StreamChunk {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    message?: {
      role: string;
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: unknown;
}

type StreamChunkContent = {
  chunk: StreamChunk;
};

type BoardUpdateContent = {
  publish_count: number;
};

type ChainUpdateContent = {
  from: string;
  to: string;
  brief: string;
  head_pos: number;
};

type MemberStatusContent = {
  state: string;
};

type HumanRequestContent = {
  session_id: string;
  from: string;
  to: string;
  brief: string;
  detail: string;
};

interface WorkspaceEvent<T> {
  metadata: EventMetadata;
  content: T;
}

interface ToolCallAccum {
  id: string;
  name: string;
  arguments: string;
}

function formatToolAccum(tc: ToolCallAccum): string {
  if (!tc.arguments) return tc.name;
  try {
    const obj = JSON.parse(tc.arguments);
    const pairs = Object.entries(obj)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`)
      .join(', ');
    return `${tc.name}(${pairs})`;
  } catch {
    return `${tc.name}(${tc.arguments.slice(0, 80)})`;
  }
}

interface MemberAccum {
  text: string;
  tools: ToolCallAccum[];
}

export const useChatStore = defineStore('chat', () => {
  const serverUrl = ref('http://127.0.0.1:3939');
  const workspaceName = ref('');
  const workspaces = ref<string[]>([]);
  const messages = ref<DisplayMessage[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  // workspace stream state
  let wsStream: EventSource | null = null;
  const boardPublishCount = ref(0);
  const memberStates = ref<Record<string, string>>({});
  const chainLog = ref<Array<{ from: string; to: string; brief: string }>>([]);
  const inbox = ref<InboxItem[]>([]);
  const activeRequest = ref<InboxItem | null>(null);

  // per-member accumulators for shared stream chunks
  const memberAccum = ref<Record<string, MemberAccum>>({});
  const streamingMsgIdx = ref<Record<string, number>>({});

  function handleStreamChunkEvent(content: StreamChunkContent, memberId: string) {
    const chunk = content.chunk;
    if (!memberAccum.value[memberId]) {
      memberAccum.value[memberId] = { text: '', tools: [] };
      // 第一条 chunk，push 新消息
      messages.value.push({ role: memberId, brief: '', detail: '' });
      streamingMsgIdx.value[memberId] = messages.value.length - 1;
    }
    const a = memberAccum.value[memberId]!;
    const msg = messages.value[streamingMsgIdx.value[memberId]!];

    let text = '';
    const delta = chunk.choices[0]?.delta;
    if (delta) {
      text = delta.content ?? '';
    } else {
      const msgChoice = chunk.choices[0]?.message;
      text = msgChoice?.content ?? '';
      const msgTCs = msgChoice?.tool_calls;
      if (msgTCs && msgTCs.length > 0) {
        for (const tc of msgTCs) {
          a.tools.push({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
        }
      }
    }
    if (text) {
      a.text += text;
      if (msg) msg.brief += text;
    }

    const tcs = delta?.tool_calls;
    if (tcs) {
      for (const tc of tcs) {
        const idx = tc.index ?? 0;
        while (a.tools.length <= idx) {
          a.tools.push({ id: '', name: '', arguments: '' });
        }
        const t = a.tools[idx]!;
        if (tc.function?.name) t.name = tc.function.name;
        if (tc.function?.arguments) t.arguments += tc.function.arguments;
        if (tc.id && !t.id) t.id = tc.id;
      }
      // 实时更新 tool detail
      if (msg) msg.detail = a.tools.filter((t) => t.name).map(formatToolAccum).join('\n');
    }
  }

  function handleBoardUpdateEvent(content: BoardUpdateContent) {
    boardPublishCount.value = content.publish_count;
  }

  function handleChainUpdateEvent(content: ChainUpdateContent) {
    chainLog.value.push({
      from: content.from,
      to: content.to,
      brief: content.brief,
    });
    if (chainLog.value.length > 10) chainLog.value.shift();
  }

  function handleMemberStatusEvent(content: MemberStatusContent, memberId: string) {
    memberStates.value = {
      ...memberStates.value,
      [memberId]: content.state,
    };
    if (content.state === 'idle') {
      flushMember(memberId);
      loading.value = false;
    }
  }

  function handleHumanRequestEvent(content: HumanRequestContent) {
    const item: InboxItem = {
      session_id: content.session_id,
      from: content.from,
      to: content.to,
      brief: content.brief,
      detail: content.detail,
    };
    inbox.value.push(item);
    if (!activeRequest.value) {
      activeRequest.value = item;
    }
    messages.value.push({
      role: 'manager',
      brief: `${item.from} → ${item.to}: ${item.brief}`,
      detail: item.detail,
    });
  }

  function flushMember(mid: string) {
    const a = memberAccum.value[mid];
    if (!a) return;
    const text = a.text.trim();
    const toolText = a.tools
      .filter((t) => t.name)
      .map(formatToolAccum)
      .join('\n');

    // 如果已经有流式消息，只更新 tool detail（文本已实时推送）
    const idx = streamingMsgIdx.value[mid];
    if (idx !== undefined) {
      const msg = messages.value[idx];
      if (msg) {
        if (toolText) msg.detail = toolText;
        if (text && !msg.brief) msg.brief = text;
      }
      delete streamingMsgIdx.value[mid];
      delete memberAccum.value[mid];
      return;
    }

    if (!text && !toolText) {
      delete memberAccum.value[mid];
      return;
    }
    messages.value.push({ role: mid, brief: text, detail: toolText });
    delete memberAccum.value[mid];
  }

  function connectStream() {
    if (!workspaceName.value) return;
    if (wsStream) {
      wsStream.close();
      wsStream = null;
    }

    const url = `${serverUrl.value}/workspace/${workspaceName.value}/stream`;
    wsStream = new EventSource(url);

    wsStream.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        const { metadata, content } = event;

        switch (metadata?.event) {
          case 'stream_chunk':
            handleStreamChunkEvent(content, metadata.member_id);
            break;
          case 'board_update':
            handleBoardUpdateEvent(content);
            break;
          case 'chain_update':
            handleChainUpdateEvent(content);
            break;
          case 'member_status':
            handleMemberStatusEvent(content, metadata.member_id);
            break;
          case 'human_request':
            handleHumanRequestEvent(content);
            break;
        }
      } catch {
        // ignore parse errors
      }
    };

    wsStream.onerror = () => {
      wsStream?.close();
      wsStream = null;
      setTimeout(connectStream, 2000);
    };
  }

  watch(workspaceName, () => {
    memberStates.value = {};
    memberAccum.value = {};
    streamingMsgIdx.value = {};
    chainLog.value = [];
    boardPublishCount.value = 0;
    inbox.value = [];
    activeRequest.value = null;
    connectStream();
  });

  async function send(detail: string) {
    const text = detail.trim();
    if (!text || !workspaceName.value) return;

    messages.value.push({ role: 'user', brief: '用户消息', detail: text });
    error.value = null;
    loading.value = true;

    try {
      const res = await sendToWorkspace(serverUrl.value, workspaceName.value, {
        brief: '用户消息',
        detail: text,
      });
      if (!res.ok || !res.task_id) throw new Error('failed to send');
      memberAccum.value = {};
      streamingMsgIdx.value = {};
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      loading.value = false;
    }
  }

  async function loadWorkspaces() {
    try {
      workspaces.value = await fetchWorkspaces(serverUrl.value);
    } catch {
      workspaces.value = [];
    }
  }

  async function replyToRequest(sessionId: string, summary: string, detail: string) {
    error.value = null;
    loading.value = true;
    messages.value.push({ role: 'user', brief: summary, detail: detail });
    try {
      await replyToHumanRequest(serverUrl.value, sessionId, summary, detail);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
      inbox.value = inbox.value.filter((r) => r.session_id !== sessionId);
      activeRequest.value = null;
    }
  }

  function dismissInboxItem(sessionId: string) {
    inbox.value = inbox.value.filter((r) => r.session_id !== sessionId);
    if (activeRequest.value?.session_id === sessionId) {
      activeRequest.value = null;
    }
  }

  function cancelActiveRequest() {
    activeRequest.value = null;
  }

  function clear() {
    messages.value = [];
    error.value = null;
  }

  return {
    serverUrl,
    workspaceName,
    workspaces,
    messages,
    loading,
    error,
    boardPublishCount,
    memberStates,
    chainLog,
    inbox,
    activeRequest,
    loadWorkspaces,
    send,
    replyToRequest,
    dismissInboxItem,
    cancelActiveRequest,
    clear,
  };
});
