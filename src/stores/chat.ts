import { ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { sendToWorkspace, fetchWorkspaces, replyToHumanRequest } from '@/api/workspace';

export interface DisplayMessage {
  role: 'user' | 'manager';
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

const DONE = '{"type":"done"}';

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
      .map(
        ([k, v]) =>
          `${k}: ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`,
      )
      .join(', ');
    return `${tc.name}(${pairs})`;
  } catch {
    return `${tc.name}(${tc.arguments.slice(0, 80)})`;
  }
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
  let taskEs: EventSource | null = null;
  const boardPublishCount = ref(0);
  const memberStates = ref<Record<string, string>>({});
  const chainLog = ref<Array<{ from: string; to: string; brief: string }>>([]);
  const inbox = ref<InboxItem[]>([]);
  const activeRequest = ref<InboxItem | null>(null);

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
        switch (event.type) {
          case 'board_update':
            boardPublishCount.value = event.publish_count ?? 0;
            break;
          case 'member_status':
            memberStates.value = {
              ...memberStates.value,
              [event.member_id]: event.state,
            };
            break;
          case 'chain_update': {
            const from = event.from ?? '';
            const to = event.to ?? '';
            const brief = event.brief ?? '';
            chainLog.value.push({ from, to, brief });
            if (chainLog.value.length > 10) chainLog.value.shift();
            messages.value.push({
              role: 'manager',
              brief: `${from} → ${to}: ${brief}`,
              detail: '',
            });
            break;
          }
          case 'human_request': {
            const item: InboxItem = {
              session_id: event.session_id ?? '',
              from: event.from ?? '',
              to: event.to ?? '',
              brief: event.brief ?? '',
              detail: event.detail ?? '',
            };
            inbox.value.push(item);
            if (!activeRequest.value) {
              activeRequest.value = item;
            }
            messages.value.push({
              role: 'manager',
              brief: `📨 ${item.from} → ${item.to}: ${item.brief}`,
              detail: item.detail,
            });
            break;
          }
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
      streamEvents(res.task_id);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      loading.value = false;
    }
  }

  function streamEvents(taskId: string): Promise<void> {
    return new Promise((resolve) => {
      if (taskEs) { taskEs.close(); taskEs = null; }
      const url = `${serverUrl.value}/workspace/${workspaceName.value}/events/${taskId}`;
      const es = new EventSource(url);
      taskEs = es;
      let currentMsgIdx = -1;
      let lastHadFinish = false;
      const toolAccum: ToolCallAccum[] = [];

      es.onmessage = (e) => {
        // DONE 仅是 LLM 轮次边界，不关闭连接——子委托返回后可能继续处理同一 task
        if (e.data === DONE) {
          if (toolAccum.length > 0) {
            const flushed = toolAccum
              .filter((t) => t.name)
              .map(formatToolAccum)
              .join('\n');
            if (flushed) {
              const msg = messages.value[currentMsgIdx];
              if (msg) msg.detail = (msg.detail ? msg.detail + '\n' : '') + flushed;
            }
            toolAccum.length = 0;
          }
          lastHadFinish = true;
          loading.value = false;
          return;
        }

        const chunk = JSON.parse(e.data);
        let text = '';
        let toolText = '';

        const delta = (chunk?.choices as Array<Record<string, unknown>>)?.[0]
          ?.delta as Record<string, unknown>;
        if (delta) {
          text = (delta.content || delta['content']) as string ?? '';
        } else {
          // ChatResponse (fallback): 一次性拿到完整响应，text+toolText 同帧
          const msg = (chunk?.choices as Array<Record<string, unknown>>)?.[0]
            ?.message as Record<string, unknown>;
          text = (msg?.content || msg?.['content']) as string ?? '';
          const msgTCs = (msg?.tool_calls || msg?.['tool_calls']) as
            | Array<Record<string, unknown>>
            | undefined;
          if (msgTCs && msgTCs.length > 0) {
            toolText = msgTCs
              .map((tc: Record<string, unknown>) => {
                const fn = tc.function as Record<string, string> | undefined;
                const name = fn?.name || '';
                const args = fn?.arguments || '';
                const obj: ToolCallAccum = {
                  id: (tc.id as string) || '',
                  name,
                  arguments: args,
                };
                return formatToolAccum(obj);
              })
              .join('\n');
          }
        }

        const tcs = (delta?.tool_calls || delta?.['tool_calls']) as
          | Array<Record<string, unknown>>
          | undefined;
        if (tcs) {
          for (const tc of tcs) {
            const idx = (tc.index as number) ?? 0;
            while (toolAccum.length <= idx) {
              toolAccum.push({ id: '', name: '', arguments: '' });
            }
            const a = toolAccum[idx]!;
            const fn = tc.function as Record<string, string> | undefined;
            if (fn) {
              if (fn.name) a.name = fn.name;
              if (fn.arguments) a.arguments += fn.arguments;
            }
            if ((tc.id as string) && !a.id) a.id = tc.id as string;
          }
        }

        if (lastHadFinish) {
          lastHadFinish = false;
          if (text || toolText) {
            messages.value.push({ role: 'manager', brief: text, detail: toolText });
            currentMsgIdx = messages.value.length - 1;
          }
        } else if (currentMsgIdx < 0) {
          if (text || toolText) {
            messages.value.push({ role: 'manager', brief: text, detail: toolText });
            currentMsgIdx = messages.value.length - 1;
          }
        } else {
          const msg = messages.value[currentMsgIdx];
          if (msg) {
            if (text) msg.brief += text;
            if (toolText) msg.detail = (msg.detail ? msg.detail + '\n' : '') + toolText;
          }
        }
      };

      es.onerror = () => {
        es.close();
        resolve();
      };
    });
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
