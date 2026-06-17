<script setup lang="ts">
import type { TerminalDto } from '~/types';
import UsageWidget from '~/components/UsageWidget.vue';

const terminals = useTerminalsStore();
const groups = useGroupsStore();
const settings = useSettingsStore();
const theme = useThemeStore();
const socket = useSocket();
const config = useRuntimeConfig();
const apiBase = computed(() => String(config.public.apiBase));

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
    <LazyTigerView v-else @back="view = 'terminals'" />

    <BaseModal :open="!!(terminals.loadError && !terminals.loaded)">
      <EmptyState
        title="Can't reach the backend"
        :description="`${apiBase} - ${terminals.loadError}`"
        tone="error"
      >
        <p class="dim">Is <code>npm run dev</code> running?</p>
        <button class="retry" @click="loadAll">Retry</button>
      </EmptyState>
    </BaseModal>

    <LazyTerminalEditModal
      v-if="showEditor"
      :terminal="editing"
      @close="showEditor = false"
      @saved="() => terminals.fetchAll().catch(() => {})"
    />
    <LazyGroupsModal v-if="showGroups" @close="showGroups = false" />
    <LazyPromptComposerModal v-if="showComposer" @close="showComposer = false" />
    <LazySettingsModal v-if="showSettings && settings.settings" @close="showSettings = false" />
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
