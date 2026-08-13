<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import {
  Activity,
  Bot,
  Check,
  ChevronDown,
  CircleMinus,
  CirclePlus,
  CloudOff,
  Command,
  FolderKanban,
  Menu,
  MessageSquare,
  PanelRight,
  Send,
  Settings2,
  Trash2,
  UserRound,
  UsersRound,
  Wifi,
  Wrench,
  X,
  Zap,
} from 'lucide-vue-next';

import {
  useWorkbenchStore,
  workspaceKey,
  type ConversationEntry,
  type RuntimeLog,
} from '@/stores/workbench';

const store = useWorkbenchStore();
const {
  endpoint,
  connectionStatus,
  connectionError,
  workspaces,
  selectedWorkspace,
  selectedAgent,
  selectedAgentName,
  visibleSkills,
  loadingSkills,
  visibleMessages,
  logs,
} = storeToRefs(store);

const draft = ref('');
const messageList = ref<HTMLElement | null>(null);
const sidebarOpen = ref(false);
const activityOpen = ref(true);
const settingsOpen = ref(false);
const logFilter = ref<'all' | 'errors'>('all');
const endpointDraft = ref(endpoint.value);
const formError = ref('');

const displayedLogs = computed(() => {
  if (logFilter.value === 'errors') {
    return logs.value.filter((entry) => entry.level === 'ERROR' || entry.level === 'WARN');
  }
  return logs.value;
});

const memberList = computed(() => {
  const workspace = selectedWorkspace.value;
  if (!workspace) return [];
  return workspace.agents.filter((agent) => agent !== workspace.manager);
});

const connectionLabel = computed(() => {
  if (connectionStatus.value === 'online') return 'Connected';
  if (connectionStatus.value === 'connecting') return 'Connecting';
  return 'Offline';
});

const loadingSkillSet = computed(() => new Set(loadingSkills.value));

const currentChannelLabel = computed(() => {
  const workspace = selectedWorkspace.value;
  if (!workspace) return 'Select a workspace';
  if (selectedAgent.value) return selectedAgent.value;
  return workspace.manager ? `${workspace.manager} · manager route` : 'Manager route';
});

watch(
  () => visibleMessages.value.map((message) => `${message.key}:${message.content.length}`),
  () => nextTick(scrollMessages),
);

onMounted(() => {
  if (!selectedWorkspace.value && workspaces.value[0]) {
    store.selectWorkspace(workspaceKey(workspaces.value[0]));
  }
  store.connect();
});

onBeforeUnmount(() => store.disconnect());

function submitMessage() {
  const text = draft.value.trim();
  if (!text) return;
  if (!store.sendMessage(text)) return;
  draft.value = '';
  nextTick(scrollMessages);
}

function toggleSkill(skill: string) {
  store.setSkillLoading(skill, !loadingSkillSet.value.has(skill));
}

function selectWorkspace(key: string) {
  store.selectWorkspace(key);
  sidebarOpen.value = false;
  nextTick(scrollMessages);
}

function selectMember(agent: string | null) {
  store.selectAgent(agent);
  sidebarOpen.value = false;
  nextTick(scrollMessages);
}

function openSettings() {
  endpointDraft.value = endpoint.value;
  formError.value = '';
  settingsOpen.value = true;
}

function saveSettings() {
  try {
    if (store.connect(endpointDraft.value)) settingsOpen.value = false;
  } catch (error) {
    formError.value = error instanceof Error ? error.message : String(error);
  }
}

function scrollMessages() {
  messageList.value?.scrollTo({ top: messageList.value.scrollHeight, behavior: 'smooth' });
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
    timestamp,
  );
}

function formatLogTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}

function roleLabel(message: ConversationEntry) {
  if (message.role === 'user') return 'You';
  if (message.role === 'assistant') return message.agent;
  if (message.role === 'tool') return 'Tool response';
  return 'System';
}

function toolArguments(argumentsText: string) {
  try {
    return JSON.stringify(JSON.parse(argumentsText), null, 2);
  } catch {
    return argumentsText;
  }
}

function resourceLabel(resource: string) {
  const separator = resource.indexOf(':');
  const identity = separator >= 0 ? resource.slice(separator + 1) : resource;
  return identity.endsWith(':latest') ? identity.slice(0, -':latest'.length) : identity;
}

function logLevelClass(log: RuntimeLog) {
  return `log-level--${log.level.toLowerCase()}`;
}
</script>

<template>
  <div class="app-shell">
    <div v-if="sidebarOpen" class="mobile-scrim" @click="sidebarOpen = false"></div>
    <aside :class="['workspace-sidebar', { 'workspace-sidebar--open': sidebarOpen }]">
      <div class="brand-row">
        <div class="brand-mark">
          <Command :size="17" :stroke-width="2.4" />
        </div>
        <div>
          <strong>margatroid</strong>
          <span>agent workspace</span>
        </div>
        <button
          class="icon-button sidebar-close"
          title="Close navigation"
          @click="sidebarOpen = false"
        >
          <X :size="17" />
        </button>
      </div>

      <button class="connection-strip" title="Open connection settings" @click="openSettings">
        <span :class="['status-dot', `status-dot--${connectionStatus}`]"></span>
        <span class="connection-copy">
          <strong>{{ connectionLabel }}</strong>
          <small>{{ endpoint.replace(/^wss?:\/\//, '') }}</small>
        </span>
        <Settings2 :size="16" />
      </button>

      <div class="sidebar-heading">
        <span>Workspaces</span>
      </div>

      <nav class="workspace-list" aria-label="Workspaces">
        <button
          v-for="workspace in workspaces"
          :key="workspaceKey(workspace)"
          :class="[
            'workspace-item',
            {
              'workspace-item--active':
                selectedWorkspace && workspaceKey(selectedWorkspace) === workspaceKey(workspace),
            },
          ]"
          @click="selectWorkspace(workspaceKey(workspace))"
        >
          <FolderKanban :size="17" />
          <span class="workspace-item__copy">
            <strong>{{ workspace.name }}</strong>
            <small>{{ workspace.project_root }}</small>
          </span>
          <ChevronDown
            v-if="selectedWorkspace && workspaceKey(selectedWorkspace) === workspaceKey(workspace)"
            :size="15"
          />
        </button>
        <div v-if="!workspaces.length" class="sidebar-empty">
          <span>No workspace running</span>
        </div>
      </nav>

      <template v-if="selectedWorkspace">
        <div class="sidebar-heading sidebar-heading--members">
          <span>Members</span>
          <span class="count-badge">{{ selectedWorkspace.agents.length }}</span>
        </div>
        <div class="member-list">
          <button
            :class="['member-item', { 'member-item--active': selectedAgent === null }]"
            @click="selectMember(null)"
          >
            <span class="member-avatar member-avatar--manager">
              <Zap :size="15" />
            </span>
            <span class="member-item__copy">
              <strong>{{ selectedWorkspace.manager || 'Manager' }}</strong>
              <small>default route</small>
            </span>
            <Check v-if="selectedAgent === null" :size="15" />
          </button>
          <button
            v-for="agent in memberList"
            :key="agent"
            :class="['member-item', { 'member-item--active': selectedAgent === agent }]"
            @click="selectMember(agent)"
          >
            <span class="member-avatar">
              <Bot :size="15" />
            </span>
            <span class="member-item__copy">
              <strong>{{ agent }}</strong>
              <small>{{ agent === selectedWorkspace.manager ? 'manager' : 'agent' }}</small>
            </span>
            <Check v-if="selectedAgent === agent" :size="15" />
          </button>
        </div>
      </template>

      <div class="sidebar-footer">
        <button class="footer-action" title="Open connection settings" @click="openSettings">
          <Settings2 :size="16" />
          <span>Connection</span>
        </button>
      </div>
    </aside>

    <main class="conversation-pane">
      <header class="conversation-header">
        <button class="icon-button mobile-menu" title="Open navigation" @click="sidebarOpen = true">
          <Menu :size="19" />
        </button>
        <div class="conversation-heading">
          <div class="channel-avatar">
            <UserRound :size="17" />
          </div>
          <div>
            <div class="channel-title">{{ currentChannelLabel }}</div>
            <div class="channel-subtitle">
              <span v-if="selectedWorkspace">{{ selectedWorkspace.name }}</span>
              <span v-if="selectedWorkspace">·</span>
              <span>{{ connectionLabel.toLowerCase() }}</span>
            </div>
          </div>
        </div>
        <div class="header-actions">
          <button
            class="icon-button"
            :class="{ 'icon-button--active': activityOpen }"
            title="Toggle activity"
            @click="activityOpen = !activityOpen"
          >
            <PanelRight :size="18" />
          </button>
        </div>
      </header>

      <section ref="messageList" class="message-list" aria-live="polite">
        <div v-if="!selectedWorkspace" class="empty-state">
          <div class="empty-icon">
            <UsersRound :size="23" />
          </div>
          <strong>Choose a workspace</strong>
        </div>
        <div v-else-if="!visibleMessages.length" class="empty-state empty-state--conversation">
          <div class="empty-icon">
            <MessageSquare :size="22" />
          </div>
          <strong>{{ selectedAgentName }}</strong>
          <span>Conversation is ready.</span>
        </div>

        <article
          v-for="message in visibleMessages"
          :key="message.key"
          :class="['message-row', `message-row--${message.role}`]"
        >
          <div class="message-avatar">
            <UserRound v-if="message.role === 'user'" :size="16" />
            <Bot v-else-if="message.role === 'assistant'" :size="16" />
            <Wrench v-else-if="message.role === 'tool'" :size="15" />
            <Zap v-else :size="15" />
          </div>
          <div class="message-body">
            <div class="message-meta">
              <strong>{{ roleLabel(message) }}</strong>
              <span>{{ formatTime(message.timestamp) }}</span>
            </div>
            <p v-if="message.content" class="message-content">{{ message.content }}</p>
            <div v-if="message.toolCalls.length" class="tool-call-list">
              <div v-for="tool in message.toolCalls" :key="tool.id" class="tool-call-row">
                <Wrench :size="14" />
                <span>{{ tool.tool_name }}</span>
                <code v-if="tool.arguments">{{ toolArguments(tool.arguments) }}</code>
              </div>
            </div>
            <div v-if="message.role === 'tool'" class="tool-response-label">Tool response</div>
          </div>
        </article>

        <div v-if="connectionError" class="inline-error">
          <CloudOff :size="16" />
          <span>{{ connectionError }}</span>
          <button class="text-button" @click="openSettings">Configure</button>
        </div>
      </section>

      <footer class="composer">
        <div class="composer-context">
          <span class="context-dot"></span>
          <span>Message {{ selectedAgentName }}</span>
          <span v-if="selectedWorkspace">in {{ selectedWorkspace.name }}</span>
        </div>
        <div v-if="selectedWorkspace" class="visible-skills" aria-label="Visible skills">
          <div class="visible-skills-label">
            <Wrench :size="13" />
            <span>Visible skills</span>
            <button
              v-if="loadingSkills.length"
              class="skill-clear-button"
              type="button"
              title="Unload all skills"
              @click="store.unloadAllSkills"
            >
              <Trash2 :size="13" />
              <span>Unload all</span>
            </button>
          </div>
          <div v-if="visibleSkills.length" class="visible-skills-list">
            <div v-for="skill in visibleSkills" :key="skill" class="visible-skill-row">
              <code>{{ resourceLabel(skill) }}</code>
              <button
                class="skill-toggle-button"
                type="button"
                :title="loadingSkillSet.has(skill) ? 'Unload skill' : 'Load skill'"
                :aria-label="loadingSkillSet.has(skill) ? 'Unload skill' : 'Load skill'"
                :disabled="connectionStatus !== 'online'"
                @click="toggleSkill(skill)"
              >
                <CircleMinus v-if="loadingSkillSet.has(skill)" :size="14" />
                <CirclePlus v-else :size="14" />
              </button>
            </div>
          </div>
          <span v-else class="visible-skills-empty">No visible skills</span>
        </div>
        <form class="composer-box" @submit.prevent="submitMessage">
          <textarea
            v-model="draft"
            :disabled="!selectedWorkspace || connectionStatus !== 'online'"
            rows="1"
            :placeholder="
              selectedWorkspace ? `Message ${selectedAgentName}...` : 'Select a workspace...'
            "
            @keydown.enter.exact.prevent="submitMessage"
          ></textarea>
          <button
            class="send-button"
            type="submit"
            title="Send message"
            :disabled="!draft.trim() || !selectedWorkspace || connectionStatus !== 'online'"
          >
            <Send :size="18" />
          </button>
        </form>
      </footer>
    </main>

    <aside v-if="activityOpen" class="activity-panel">
      <div class="activity-header">
        <div>
          <span class="eyebrow">Runtime</span>
          <h2>Activity</h2>
        </div>
        <button class="icon-button" title="Close activity" @click="activityOpen = false">
          <X :size="17" />
        </button>
      </div>
      <div class="activity-tabs" role="tablist">
        <button :class="{ active: logFilter === 'all' }" @click="logFilter = 'all'">
          All <span>{{ logs.length }}</span>
        </button>
        <button :class="{ active: logFilter === 'errors' }" @click="logFilter = 'errors'">
          Errors
          <span>{{
            logs.filter((log) => log.level === 'ERROR' || log.level === 'WARN').length
          }}</span>
        </button>
      </div>
      <div class="activity-list">
        <div v-if="!displayedLogs.length" class="activity-empty">
          <Activity :size="18" />
          <span>No runtime events</span>
        </div>
        <div v-for="log in displayedLogs" :key="log.key" class="log-entry">
          <span :class="['log-level', logLevelClass(log)]">{{ log.level }}</span>
          <div class="log-copy">
            <p>{{ log.message }}</p>
            <small>{{ log.target }} · {{ formatLogTime(log.timestamp) }}</small>
            <code v-for="field in log.fields" :key="field.name"
              >{{ field.name }}={{ field.value }}</code
            >
          </div>
        </div>
      </div>
      <button class="activity-clear" @click="store.clearLogs">Clear activity</button>
    </aside>

    <div v-if="settingsOpen" class="dialog-backdrop" @click.self="settingsOpen = false">
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div class="dialog-header">
          <div>
            <span class="eyebrow">Daemon</span>
            <h2 id="settings-title">Connection</h2>
          </div>
          <button class="icon-button" title="Close" @click="settingsOpen = false">
            <X :size="17" />
          </button>
        </div>
        <label class="field-label" for="endpoint">WebSocket endpoint</label>
        <input
          id="endpoint"
          v-model="endpointDraft"
          class="field-input"
          placeholder="ws://127.0.0.1:3939/ws"
          @keydown.enter="saveSettings"
        />
        <p v-if="formError" class="form-error">{{ formError }}</p>
        <div class="dialog-actions">
          <button class="secondary-button" @click="settingsOpen = false">Cancel</button>
          <button class="primary-button" @click="saveSettings"><Wifi :size="16" /> Connect</button>
        </div>
      </section>
    </div>
  </div>
</template>
