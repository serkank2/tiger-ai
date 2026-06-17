<script setup lang="ts">
import type { TerminalDto } from '~/types';
import PromptComposerModal from '~/components/PromptComposerModal.vue';
import TigerView from '~/components/tiger/TigerView.vue';
import UsageWidget from '~/components/UsageWidget.vue';

const terminals = useTerminalsStore();
const groups = useGroupsStore();
const settings = useSettingsStore();
const theme = useThemeStore();
const socket = useSocket();

const view = ref<'terminals' | 'tiger'>('terminals');
const showEditor = ref(false);
const editing = ref<TerminalDto | null>(null);
const showGroups = ref(false);
const showSettings = ref(false);
const showComposer = ref(false);
const documentVisible = ref(true);
const shouldPollPreviews = computed(
  () => documentVisible.value && view.value === 'terminals' && terminals.items.length > 0,
);

function openCreate() {
  editing.value = null;
  showEditor.value = true;
}
function openEdit(t: TerminalDto) {
  editing.value = t;
  showEditor.value = true;
}

async function loadAll() {
  try {
    await Promise.all([terminals.fetchAll(), groups.load(), settings.load()]);
  } catch (err) {
    console.error('[kaplan] initial load failed (is the backend running?)', err);
  } finally {
    theme.init(settings.settings?.theme); // apply persisted theme (default if unavailable)
  }
}

// Self-scheduling preview refresh: waits for each request before the next, never overlaps,
// and stops cleanly when the terminal panel is not visible. (Live status itself arrives via WebSocket.)
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
function clearPreviewPollTimer() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}
function schedulePreviewPoll(delay = 4000) {
  if (disposed || pollTimer || !shouldPollPreviews.value) return;
  pollTimer = setTimeout(pollLoop, delay);
}
async function pollLoop() {
  pollTimer = null;
  if (disposed || !shouldPollPreviews.value) return;
  try {
    await terminals.refreshPreviews();
  } catch {
    /* ignore transient errors */
  }
  schedulePreviewPoll();
}
function syncPreviewPoll() {
  if (shouldPollPreviews.value) schedulePreviewPoll(0);
  else clearPreviewPollTimer();
}
function updateDocumentVisibility() {
  documentVisible.value = document.visibilityState !== 'hidden';
}

onMounted(async () => {
  socket.connect();
  updateDocumentVisibility();
  document.addEventListener('visibilitychange', updateDocumentVisibility);
  await loadAll();
  syncPreviewPoll();
});
onBeforeUnmount(() => {
  disposed = true;
  document.removeEventListener('visibilitychange', updateDocumentVisibility);
  clearPreviewPollTimer();
});
watch(shouldPollPreviews, syncPreviewPoll);
</script>

<template>
  <div class="app">
    <template v-if="view === 'terminals'">
      <CommandBar
        @create="openCreate"
        @manage-groups="showGroups = true"
        @open-settings="showSettings = true"
        @open-composer="showComposer = true"
        @open-tiger="view = 'tiger'"
      />
      <div class="body">
        <TerminalSidebar @create="openCreate" @edit="openEdit" />
        <TerminalPane v-if="terminals.layoutMode === 'focus'" />
        <TerminalGrid v-else @create="openCreate" />
      </div>
    </template>
    <TigerView v-else @back="view = 'terminals'" />

    <div v-if="terminals.loadError && !terminals.loaded" class="backend-down">
      <div class="card">
        <p class="big">⚠ Can't reach the backend</p>
        <p class="dim">http://127.0.0.1:4517 — {{ terminals.loadError }}</p>
        <p class="dim">Is <code>npm run dev</code> running?</p>
        <button class="retry" @click="loadAll">Retry</button>
      </div>
    </div>

    <TerminalEditModal
      v-if="showEditor"
      :terminal="editing"
      @close="showEditor = false"
      @saved="() => terminals.fetchAll().catch(() => {})"
    />
    <GroupsModal v-if="showGroups" @close="showGroups = false" />
    <PromptComposerModal v-if="showComposer" @close="showComposer = false" />
    <SettingsModal v-if="showSettings && settings.settings" @close="showSettings = false" />
    <UsageWidget />
    <NoticeToast />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.body {
  display: flex;
  flex: 1;
  min-height: 0;
  position: relative;
}
.backend-down {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.6);
  z-index: 40;
}
.card {
  text-align: center;
  background: var(--bg-elev);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: 28px 32px;
  box-shadow: var(--shadow);
}
.big {
  font-size: 16px;
  font-weight: 700;
  margin: 0 0 8px;
}
.dim {
  color: var(--text-dim);
  margin: 4px 0;
  font-size: 13px;
}
.dim code {
  font-family: var(--font-mono);
  color: var(--accent);
}
.retry {
  margin-top: 14px;
  border: 1px solid var(--accent);
  color: var(--accent);
  padding: 8px 18px;
  font-weight: 600;
}
.retry:hover {
  background: var(--accent-soft);
}
</style>
