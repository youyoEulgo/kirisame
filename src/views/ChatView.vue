<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue';
import { useChatStore } from '@/stores/chat';

const store = useChatStore();
const input = ref('');
const detail = ref('');
const listEl = ref<HTMLElement | null>(null);

onMounted(() => {
  store.loadWorkspaces();
});

async function submit() {
  const text = input.value.trim();
  if (!text || store.loading) return;
  input.value = '';
  const d = detail.value.trim();
  detail.value = '';
  await store.send(text, d || undefined);
  await nextTick();
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: 'smooth' });
}
</script>

<template>
  <div class="chat">
    <header class="chat-bar">
      <label class="bar-label">server</label>
      <input
        v-model="store.serverUrl"
        placeholder="http://127.0.0.1:3939"
        class="bar-url"
      />
      <label class="bar-label">ws</label>
      <select
        v-model="store.workspaceName"
        class="bar-select"
        @focus="store.loadWorkspaces()"
      >
        <option value="" disabled>select…</option>
        <option v-for="w in store.workspaces" :key="w" :value="w">{{ w }}</option>
      </select>
      <button @click="store.clear()" class="bar-clear">clear</button>
    </header>

    <div ref="listEl" class="chat-list">
      <div v-if="!store.messages.length" class="chat-empty">
        enter a workspace URL and send a message to start
      </div>
      <div
        v-for="(m, i) in store.messages"
        :key="i"
        :class="['chat-msg', `chat-msg--${m.role}`]"
      >
        <span class="chat-msg-role">{{ m.role }}</span>
        <p class="chat-msg-brief">{{ m.brief }}</p>
        <pre v-if="m.detail" class="chat-msg-detail">{{ m.detail }}</pre>
      </div>
      <div v-if="store.loading" class="chat-msg chat-msg--manager">
        <span class="chat-msg-role">manager</span>
        <p class="chat-msg-brief thinking">…</p>
      </div>
      <div v-if="store.error" class="chat-error">{{ store.error }}</div>
    </div>

    <form @submit.prevent="submit" class="chat-input-wrap">
      <div class="chat-input-group">
        <input
          v-model="input"
          class="chat-input-brief"
          placeholder="brief — what do you want done?"
          @keydown.enter.exact="submit"
        />
        <input
          v-model="detail"
          class="chat-input-detail"
          placeholder="detail (optional)"
        />
      </div>
      <button type="submit" :disabled="store.loading" class="chat-send">send</button>
    </form>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100vh;
  max-width: 720px;
  margin: 0 auto;
}
.chat-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid #333;
  flex-shrink: 0;
}
.bar-label { color: #888; font-size: 13px; flex-shrink: 0; }
.bar-url { flex: 1; }
.bar-select { width: 120px; }
.bar-clear { flex-shrink: 0; }
.chat-list {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}
.chat-empty {
  color: #666;
  text-align: center;
  margin-top: 40px;
}
.chat-msg {
  margin-bottom: 20px;
}
.chat-msg-role {
  font-size: 12px;
  color: #888;
  text-transform: uppercase;
}
.chat-msg-brief {
  margin: 4px 0 0;
  font-weight: 600;
}
.chat-msg-detail {
  margin: 8px 0 0;
  white-space: pre-wrap;
  font-family: inherit;
  color: #999;
  font-size: 13px;
  border-left: 2px solid #444;
  padding-left: 10px;
}
.chat-msg--user .chat-msg-brief { color: #ccc; }
.chat-msg--manager .chat-msg-brief { color: #fff; }
.thinking { color: #888; font-weight: 400; }
.chat-error { color: #f66; margin-top: 8px; }
.chat-input-wrap {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid #333;
  flex-shrink: 0;
}
.chat-input-group { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.chat-input-brief {
  font: inherit;
  padding: 6px 8px;
  background: #1a1a1a;
  color: #fff;
  border: 1px solid #444;
  border-radius: 4px;
}
.chat-input-detail {
  font: inherit;
  font-size: 14px;
  padding: 6px 8px;
  background: #1a1a1a;
  color: #aaa;
  border: 1px solid #444;
  border-radius: 4px;
}
.chat-send { flex-shrink: 0; padding: 0 16px; }
button {
  background: #333;
  color: #fff;
  border: 1px solid #555;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
}
button:disabled { opacity: 0.4; }
input[type='text'] {
  background: #1a1a1a;
  color: #fff;
  border: 1px solid #444;
  border-radius: 4px;
  padding: 4px 8px;
  font: inherit;
}
</style>
