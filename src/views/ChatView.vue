<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue';
import { useChatStore } from '@/stores/chat';

const store = useChatStore();
const detail = ref('');
const listEl = ref<HTMLElement | null>(null);

onMounted(() => {
  store.loadWorkspaces();
});

async function submit() {
  const text = detail.value.trim();
  if (!text || (store.loading && !store.activeRequest)) return;
  detail.value = '';

  if (store.activeRequest) {
    await store.replyToRequest(store.activeRequest.session_id, text, '');
  } else {
    store.send(text);
  }
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
      <span v-if="store.boardPublishCount > 0" class="bar-pending">
        {{ store.boardPublishCount }}
      </span>
      <button @click="store.clear()" class="bar-clear">clear</button>
    </header>

    <div v-if="store.workspaceName" class="member-bar">
      <span
        v-for="(state, id) in store.memberStates"
        :key="id"
        :class="['member-tag', state]"
      >
        {{ id }} <em class="member-state">{{ state }}</em>
      </span>
      <span v-if="!Object.keys(store.memberStates).length" class="member-tag empty">
        connecting…
      </span>
      <div v-if="store.chainLog.length" class="chain-log">
        <span
          v-for="(entry, i) in store.chainLog.slice(-5)"
          :key="i"
          class="chain-item"
        >
          {{ entry.from }}→{{ entry.to }}
        </span>
      </div>
    </div>

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
        <p :class="['chat-msg-brief', { 'chat-msg-brief--sub': m.role !== 'user' && m.role !== 'manager' }]">{{ m.brief }}</p>
        <pre v-if="m.detail" :class="['chat-msg-detail', { 'chat-msg-detail--sub': m.role !== 'user' && m.role !== 'manager' }]">{{ m.detail }}</pre>
      </div>
      <div v-if="store.loading" class="chat-msg chat-msg--manager">
        <span class="chat-msg-role">manager</span>
        <p class="chat-msg-brief thinking">…</p>
      </div>
      <div v-if="store.error" class="chat-error">{{ store.error }}</div>
    </div>

    <form @submit.prevent="submit" class="chat-input-wrap">
      <div v-if="store.activeRequest" class="reply-context">
        回复 {{ store.activeRequest.from }}: {{ store.activeRequest.brief }}
        <button
          type="button"
          @click="store.cancelActiveRequest()"
          class="reply-cancel"
        >
          取消
        </button>
      </div>
      <div class="chat-input-row">
        <textarea
          v-model="detail"
          class="chat-input-detail"
          rows="3"
          :placeholder="store.activeRequest ? '输入你的回复…' : 'type a message…'"
          @keydown.enter.exact.prevent="submit"
        />
        <button
          type="submit"
          :disabled="store.loading && !store.activeRequest"
          class="chat-send"
        >
          {{ store.activeRequest ? 'finish' : 'send' }}
        </button>
      </div>
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
.bar-label {
  color: #888;
  font-size: 13px;
  flex-shrink: 0;
}
.bar-url {
  flex: 1;
}
.bar-select {
  width: 120px;
}
.bar-clear {
  flex-shrink: 0;
}
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
.chat-msg--user .chat-msg-brief {
  color: #ccc;
}
.chat-msg--manager .chat-msg-brief {
  color: #fff;
}
.chat-msg-brief--sub {
  font-size: 13px;
  color: #999;
}
.chat-msg-detail--sub {
  color: #777;
  font-size: 12px;
}
.thinking {
  color: #888;
  font-weight: 400;
}
.chat-error {
  color: #f66;
  margin-top: 8px;
}
.chat-input-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid #333;
  flex-shrink: 0;
}
.chat-input-row {
  display: flex;
  gap: 8px;
}
.chat-input-detail {
  flex: 1;
  font: inherit;
  padding: 8px;
  background: #1a1a1a;
  color: #fff;
  border: 1px solid #444;
  border-radius: 4px;
  resize: vertical;
}
.chat-send {
  flex-shrink: 0;
  padding: 0 16px;
}
button {
  background: #333;
  color: #fff;
  border: 1px solid #555;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
}
button:disabled {
  opacity: 0.4;
}
input[type='text'] {
  background: #1a1a1a;
  color: #fff;
  border: 1px solid #444;
  border-radius: 4px;
  padding: 4px 8px;
  font: inherit;
}
select {
  background: #1a1a1a;
  color: #fff;
  border: 1px solid #444;
  border-radius: 4px;
  padding: 4px 8px;
  font: inherit;
}
.bar-pending {
  font-size: 12px;
  background: #333;
  color: #aaa;
  padding: 2px 6px;
  border-radius: 8px;
  min-width: 18px;
  text-align: center;
}
.member-bar {
  display: flex;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid #333;
  flex-shrink: 0;
  overflow-x: auto;
}
.member-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 8px;
  background: #222;
  color: #888;
  white-space: nowrap;
}
.member-tag.working {
  color: #5f5;
}
.member-tag.idle {
  color: #888;
}
.member-tag.empty {
  color: #555;
}
.member-state {
  font-style: normal;
  font-size: 10px;
  margin-left: 2px;
  color: inherit;
  opacity: 0.6;
}
.chain-log {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  padding: 4px 12px;
  border-bottom: 1px solid #333;
  flex-shrink: 0;
}
.chain-item {
  font-size: 10px;
  color: #666;
  background: #1a1a1a;
  padding: 1px 5px;
  border-radius: 3px;
}
.reply-context {
  font-size: 13px;
  color: #cc5;
  display: flex;
  align-items: center;
  gap: 8px;
}
.reply-cancel {
  background: none;
  border: none;
  color: #888;
  cursor: pointer;
  font-size: 12px;
}
</style>
