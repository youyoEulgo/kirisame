import { ref } from 'vue';
import { defineStore } from 'pinia';
import { sendToWorkspace, fetchWorkspaces } from '@/api/workspace';

export interface DisplayMessage {
  role: 'user' | 'manager';
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

  async function send(brief: string, detail?: string) {
    const text = brief.trim();
    if (!text || !workspaceName.value) return;

    messages.value.push({ role: 'user', brief: text, detail: detail ?? '' });
    error.value = null;
    loading.value = true;

    try {
      const res = await sendToWorkspace(serverUrl.value, workspaceName.value, { brief: text, detail });
      if (!res.ok || !res.task_id) throw new Error('failed to send');
      await streamEvents(res.task_id);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  function streamEvents(taskId: string): Promise<void> {
    return new Promise((resolve) => {
      const url = `${serverUrl.value}/workspace/${workspaceName.value}/events/${taskId}`;
      const es = new EventSource(url);
      let currentMsgIdx = -1;
      let lastHadFinish = false;
      const toolAccum: ToolCallAccum[] = [];

      es.onmessage = (e) => {
        if (e.data === DONE) {
          es.close();
          resolve();
          return;
        }

        const chunk = JSON.parse(e.data);
        let text = '';
        let toolText = '';

        // StreamChunk: accumulate delta
        const delta = (chunk?.choices as Array<Record<string, unknown>>)?.[0]?.delta as Record<string, unknown>;
        if (delta) {
          text = (delta.content || delta['content']) as string ?? '';
          // accumulate tool calls by index
          const tcs = (delta.tool_calls || delta['tool_calls']) as Array<Record<string, unknown>> | undefined;
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
        } else {
          // ChatResponse (fallback): full message
          const msg = (chunk?.choices as Array<Record<string, unknown>>)?.[0]?.message as Record<string, unknown>;
          text = (msg?.content || msg?.['content']) as string ?? '';
          const msgTCs = (msg?.tool_calls || msg?.['tool_calls']) as Array<Record<string, unknown>> | undefined;
          if (msgTCs && msgTCs.length > 0) {
            toolText = msgTCs
              .map((tc: Record<string, unknown>) => {
                const fn = tc.function as Record<string, string> | undefined;
                const name = fn?.name || '';
                const args = fn?.arguments || '';
                const obj: ToolCallAccum = { id: (tc.id as string) || '', name, arguments: args };
                return formatToolAccum(obj);
              })
              .join('\n');
          }
        }

        const fr = (chunk?.choices as Array<Record<string, unknown>>)?.[0]?.finish_reason ?? null;

        // flush accumulated streaming tool calls on finish_reason
        if (fr && toolAccum.length > 0 && !toolText) {
          toolText = toolAccum
            .filter((t) => t.name)
            .map(formatToolAccum)
            .join('\n');
          toolAccum.length = 0;
        }

        if (!text && !toolText) return;

        if (lastHadFinish || currentMsgIdx < 0) {
          messages.value.push({ role: 'manager', brief: text, detail: toolText });
          currentMsgIdx = messages.value.length - 1;
        } else {
          const msg = messages.value[currentMsgIdx];
          if (msg) {
            if (text) msg.brief += text;
            if (toolText) msg.detail = (msg.detail ? msg.detail + '\n' : '') + toolText;
          }
        }
        lastHadFinish = fr != null;
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

  function clear() {
    messages.value = [];
    error.value = null;
  }

  return { serverUrl, workspaceName, workspaces, messages, loading, error, loadWorkspaces, send, clear };
});
