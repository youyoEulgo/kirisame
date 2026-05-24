import { ref } from 'vue';
import { defineStore } from 'pinia';
import { sendToWorkspace } from '@/api/workspace';

export interface DisplayMessage {
  role: 'user' | 'manager';
  brief: string;
  detail: string;
}

export const useChatStore = defineStore('chat', () => {
  const serverUrl = ref('http://127.0.0.1:3939');
  const workspaceName = ref('');
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
      await sendToWorkspace(serverUrl.value, workspaceName.value, { brief: text, detail });
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  function clear() {
    messages.value = [];
    error.value = null;
  }

  return { serverUrl, workspaceName, messages, loading, error, send, clear };
});
