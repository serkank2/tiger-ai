<script setup lang="ts">
// Terminals home: the live terminal grid/sidebar plus the command broadcast bar,
// relocated out of the old two-view app root into a first-class screen. Live
// streaming and status (WebSocket-driven) are unchanged — only the container moved.
import type { TerminalDto } from '~/types';
import StateView from '~/components/state/StateView.vue';

const { t } = useT();
const terminals = useTerminalsStore();
const config = useRuntimeConfig();
const apiBase = computed(() => String(config.public.apiBase));

const showEditor = ref(false);
const editing = ref<TerminalDto | null>(null);
const showGroups = ref(false);
const showComposer = ref(false);
const documentVisible = ref(true);

const shouldPollPreviews = computed(() => documentVisible.value && terminals.items.length > 0);

function openCreate() {
  editing.value = null;
  showEditor.value = true;
}
function openEdit(term: TerminalDto) {
  editing.value = term;
  showEditor.value = true;
}

async function loadTerminals() {
  try {
    await terminals.fetchAll();
  } catch (err) {
    // loadError is set on the store; the error state below renders from it.
    console.error('[kaplan] terminals load failed (is the backend running?)', err);
  }
}

// Self-scheduling preview refresh: waits for each request before the next, never
// overlaps, and stops when the page is hidden. (Live status arrives via WebSocket.)
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
  updateDocumentVisibility();
  document.addEventListener('visibilitychange', updateDocumentVisibility);
  await loadTerminals();
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
  <div class="terminals-page">
    <CommandBar
      @create="openCreate"
      @manage-groups="showGroups = true"
      @open-composer="showComposer = true"
      @open-prompts="navigateTo('/prompts')"
      @open-settings="navigateTo('/settings')"
      @open-tiger="navigateTo('/tiger')"
      @open-templates="navigateTo('/templates')"
    />

    <div v-if="terminals.loadError && !terminals.loaded" class="error-shell">
      <StateView
        kind="error"
        :title="t('terminals.cantReachBackend')"
        :description="`${apiBase} — ${terminals.loadError}`"
      >
        <p class="dim">{{ t('terminals.backendHintPrefix') }} <code>npm run dev</code> {{ t('terminals.backendHintSuffix') }}</p>
        <button class="retry" @click="loadTerminals">{{ t('common.retry') }}</button>
      </StateView>
    </div>

    <div v-else class="body">
      <TerminalSidebar @create="openCreate" @edit="openEdit" />
      <TerminalPane v-if="terminals.layoutMode === 'focus'" />
      <TerminalGrid v-else @create="openCreate" />
    </div>

    <LazyTerminalEditModal
      v-if="showEditor"
      :terminal="editing"
      @close="showEditor = false"
      @saved="() => terminals.fetchAll().catch(() => {})"
    />
    <LazyGroupsModal v-if="showGroups" @close="showGroups = false" />
    <LazyPromptComposerModal v-if="showComposer" @close="showComposer = false" />
  </div>
</template>

<style scoped>
.terminals-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.body {
  display: flex;
  flex: 1;
  min-height: 0;
  position: relative;
}
.error-shell {
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  padding: 24px;
}
.dim {
  color: var(--text-dim);
  margin: 4px 0;
  font-size: var(--text-sm);
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

/* On narrow widths the sidebar + terminal stack vertically instead of overlapping. */
@media (max-width: 720px) {
  .body {
    flex-direction: column;
  }
}
</style>
