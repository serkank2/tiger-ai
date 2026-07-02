<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useT } from '~/composables/useT';
import BaseButton from '~/components/ui/BaseButton.vue';
import BaseTabs from '~/components/ui/BaseTabs.vue';
import EmptyState from '~/components/ui/EmptyState.vue';
import PromptEditor, { type PromptDraft } from '~/components/prompt/PromptEditor.vue';
import PromptGenerationPanel from '~/components/prompt/PromptGenerationPanel.vue';
import PromptHistoryPanel from '~/components/prompt/PromptHistoryPanel.vue';
import PromptLibrary from '~/components/prompt/PromptLibrary.vue';
import PromptTargetPicker from '~/components/prompt/PromptTargetPicker.vue';
import { serializePrompt } from '~/lib/frontmatter';
import { hasPerTerminalVars, render } from '~/lib/promptTemplate';
import type { BroadcastOutcome } from '~/composables/useSocket';
import type { PromptFile, PromptHistoryEvent, PromptMeta, QueueProvider, TerminalDto, TigerAgentType } from '~/types';

const emit = defineEmits<{ back: [] }>();

type Tab = 'library' | 'history' | 'generation';
type SourceKind = 'library' | 'history' | 'generation';

interface ReuseSource {
  kind: SourceKind;
  title: string;
  text: string;
  generationId?: string | null;
  status?: string | null;
}

const prompts = usePromptsStore();
const history = usePromptHistoryStore();
const generation = usePromptGenerationStore();
const terminals = useTerminalsStore();
const groups = useGroupsStore();
const conn = useConnectionStore();
const notices = useNoticesStore();
const socket = useSocket();
const api = useApi();
const { t } = useT();

const activeTab = ref('library');
const draft = reactive<PromptDraft>({ title: '', description: '', tagsText: '', target: '', run: false, body: '' });
const values = reactive<Record<string, string>>({});
const currentPath = ref<string | null>(null);
const loadedVersion = ref<string | null>(null);
const loadedSnapshot = ref('');
const selectedTermIds = ref<string[]>([]);
const historySelectedId = ref<string | null>(null);
const savePath = ref('');
const savedPath = ref<string | null>(null);
const enqueueProvider = ref<QueueProvider>('mixed');
const runOnSend = ref(false);
const sending = ref(false);
const saving = ref(false);
const enqueuing = ref(false);
const actionError = ref<string | null>(null);

const tabs = computed<{ id: Tab; label: string }[]>(() => [
  { id: 'library', label: t('prompts.view.library') },
  { id: 'history', label: t('prompts.view.history') },
  { id: 'generation', label: t('prompts.view.generation') },
]);

const content = computed(() => serializePrompt(metaFromDraft(), draft.body));
const dirty = computed(() => content.value !== loadedSnapshot.value);
const selectedTerminals = computed(
  () => selectedTermIds.value.map((id) => terminals.byId[id]).filter(Boolean) as TerminalDto[],
);
const targetShellKinds = computed(() => selectedTerminals.value.map((t) => t.shell?.kind));
const selectedHistory = computed(() => history.items.find((item) => item.id === historySelectedId.value) ?? null);
const generationText = computed(() => generation.current?.generation.outputText?.trim() ?? '');
const currentSource = computed<ReuseSource>(() => {
  if (activeTab.value === 'history' && selectedHistory.value) {
    const item = selectedHistory.value;
    return {
      kind: 'history',
      title: historyTitle(item),
      text: historyText(item),
      generationId: item.generationId,
      status: item.status ?? null,
    };
  }
  if (activeTab.value === 'generation') {
    const record = generation.current?.generation;
    return {
      kind: 'generation',
      title: t('prompts.generation.generatedPrompt'),
      text: generationText.value,
      generationId: record?.id,
      status: record?.status ?? null,
    };
  }
  return {
    kind: 'library',
    title: draft.title.trim() || currentPath.value || t('prompts.view.libraryDraft'),
    text: draft.body,
    status: currentPath.value ? 'saved' : dirty.value ? 'editing' : null,
  };
});
const hasReusableText = computed(() => currentSource.value.text.trim().length > 0);
const canSend = computed(
  () => conn.status === 'connected' && hasReusableText.value && selectedTermIds.value.length > 0 && !sending.value,
);

watch(
  () => `${currentSource.value.kind}:${currentSource.value.title}:${currentSource.value.generationId ?? ''}`,
  () => {
    savePath.value = uniquePath(`${slug(currentSource.value.title) || 'prompt'}.md`);
    savedPath.value = null;
    actionError.value = null;
  },
  { immediate: true },
);

function parseTags(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function metaFromDraft(): PromptMeta {
  return {
    title: draft.title.trim() || undefined,
    description: draft.description.trim() || undefined,
    tags: parseTags(draft.tagsText),
    target: draft.target || undefined,
    run: draft.run,
  };
}

function setSnapshot(): void {
  loadedSnapshot.value = content.value;
}

function resetDraft(): void {
  Object.assign(draft, { title: '', description: '', tagsText: '', target: '', run: false, body: '' });
  for (const key of Object.keys(values)) delete values[key];
  currentPath.value = null;
  loadedVersion.value = null;
  setSnapshot();
}

async function openPrompt(path: string): Promise<void> {
  const file = await prompts.open(path);
  if (!file) return;
  loadFileIntoDraft(file);
  activeTab.value = 'library';
}

function loadFileIntoDraft(file: PromptFile): void {
  Object.assign(draft, {
    title: file.title ?? '',
    description: file.description ?? '',
    tagsText: (file.tags ?? []).join(', '),
    target: file.target ?? '',
    run: file.run ?? false,
    body: file.body,
  });
  for (const key of Object.keys(values)) delete values[key];
  currentPath.value = file.path;
  loadedVersion.value = file.version;
  setSnapshot();
  applyTargetHint(file.target);
}

function applyTargetHint(target?: string): void {
  if (!target) return;
  if (target === 'all') {
    selectedTermIds.value = terminals.items.filter((t) => !t.protected).map((t) => t.id);
    return;
  }
  if (target.startsWith('group:')) {
    const name = target.slice(6);
    const group = groups.groups.find((item) => item.name === name);
    if (group)
      selectedTermIds.value = terminals.items.filter((t) => t.groupId === group.id && !t.protected).map((t) => t.id);
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function uniquePath(base: string): string {
  const normalized = base.toLowerCase().endsWith('.md') ? base : `${base}.md`;
  const taken = new Set(prompts.items.map((item) => item.path));
  if (!taken.has(normalized)) return normalized;
  const stem = normalized.replace(/\.md$/i, '');
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stem}-${i}.md`;
    if (!taken.has(candidate)) return candidate;
  }
  return normalized;
}

async function saveLibraryDraft(): Promise<boolean> {
  if (!draft.body.trim() && !draft.title.trim()) {
    notices.push(t('prompts.notices.nothingToSave'), 'error');
    return false;
  }
  if (currentPath.value) {
    const file = await prompts.update(currentPath.value, content.value, loadedVersion.value ?? undefined);
    if (!file) return false;
    loadedVersion.value = file.version;
    setSnapshot();
    savedPath.value = file.path;
    notices.push(t('prompts.notices.promptSaved'), 'info');
    return true;
  }
  const file = await prompts.create(uniquePath(`${slug(draft.title) || 'untitled'}.md`), content.value);
  if (!file) return false;
  currentPath.value = file.path;
  loadedVersion.value = file.version;
  setSnapshot();
  savedPath.value = file.path;
  notices.push(t('prompts.notices.savedAs', { path: file.path }), 'info');
  return true;
}

async function saveReusableText(): Promise<void> {
  if (!hasReusableText.value || saving.value) return;
  if (currentSource.value.kind === 'library') {
    await saveLibraryDraft();
    return;
  }
  saving.value = true;
  actionError.value = null;
  try {
    const path = uniquePath(savePath.value.trim() || `${slug(currentSource.value.title) || 'prompt'}.md`);
    if (currentSource.value.kind === 'generation' && currentSource.value.generationId) {
      const res = await generation.reuse(currentSource.value.generationId, 'save-to-library', { path });
      const prompt = (res as { prompt?: PromptFile }).prompt;
      savedPath.value = prompt?.path ?? path;
      await prompts.fetchAll().catch(() => {});
      await history.fetchAll({}, { silent: true }).catch(() => {});
    } else {
      const file = await prompts.create(
        path,
        serializePrompt({ title: currentSource.value.title }, currentSource.value.text),
      );
      if (!file) return;
      savedPath.value = file.path;
    }
    notices.push(t('prompts.notices.savedTo', { path: savedPath.value }), 'info');
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

async function removePrompt(path: string): Promise<void> {
  if (!(await prompts.remove(path))) return;
  if (currentPath.value === path) resetDraft();
}

async function renamePrompt(from: string, to: string): Promise<void> {
  const dest = to.toLowerCase().endsWith('.md') ? to : `${to}.md`;
  const file = await prompts.rename(from, dest);
  if (file && currentPath.value === from) {
    currentPath.value = file.path;
    loadedVersion.value = file.version;
  }
}

function editReusableText(): void {
  if (!hasReusableText.value) return;
  Object.assign(draft, {
    title: currentSource.value.title,
    description: '',
    tagsText: currentSource.value.kind,
    target: '',
    run: false,
    body: currentSource.value.text,
  });
  for (const key of Object.keys(values)) delete values[key];
  currentPath.value = null;
  loadedVersion.value = null;
  loadedSnapshot.value = '';
  activeTab.value = 'library';
  notices.push(t('prompts.notices.loadedIntoEditor'), 'info');
}

async function enqueueReusableText(): Promise<void> {
  if (!hasReusableText.value || enqueuing.value) return;
  enqueuing.value = true;
  actionError.value = null;
  try {
    if (currentSource.value.kind === 'generation' && currentSource.value.generationId) {
      await generation.reuse(currentSource.value.generationId, 'enqueue', {
        provider: enqueueProvider.value,
      });
    } else {
      await api.enqueueQueueJob({
        prompt: currentSource.value.text,
        projectName: currentSource.value.title,
        provider: enqueueProvider.value,
      });
    }
    notices.push(t('prompts.notices.promptEnqueued'), 'info');
    await history.fetchAll({}, { silent: true }).catch(() => {});
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e);
  } finally {
    enqueuing.value = false;
  }
}

function sanitize(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[20[01]~/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
  );
}

const BRACKET_OK = new Set(['powershell', 'pwsh', 'bash', 'zsh', 'fish']);
function payloadFor(text: string, ids: string[]): string {
  const safe = sanitize(text);
  const bracket =
    safe.includes('\n') && ids.length > 0 && ids.every((id) => BRACKET_OK.has(terminals.byId[id]?.shell?.kind ?? ''));
  return bracket ? `\x1b[200~${safe}\x1b[201~` : safe;
}

function broadcastFailureMessage(result: BroadcastOutcome): string | null {
  switch (result.kind) {
    case 'ok':
      return null;
    case 'not_sent':
      return result.reason === 'server_error'
        ? `Send failed: ${result.message ?? 'the backend rejected the request.'}`
        : 'Send failed: the socket is not connected.';
    case 'timeout':
      return 'Send status unknown: no broadcast confirmation was received within 5 seconds.';
    case 'disconnected':
      return 'Send status unknown: the socket disconnected before confirming delivery.';
  }
}

async function sendReusableText(): Promise<void> {
  if (!canSend.value) return;
  sending.value = true;
  actionError.value = null;
  try {
    const ids = terminals.unprotectedIds([...selectedTermIds.value]);
    const date = new Date().toISOString().slice(0, 10);
    let delivered = false;
    let failure: string | null = null;
    if (currentSource.value.kind === 'library' && hasPerTerminalVars(currentSource.value.text)) {
      for (const id of ids) {
        const terminal = terminals.byId[id];
        if (!terminal) continue;
        const text = render(currentSource.value.text, {
          values,
          terminal: { name: terminal.name, cwd: terminal.cwd },
          date,
        });
        const result = await socket.broadcast(
          { mode: 'selected', termIds: [id] },
          payloadFor(text, [id]),
          runOnSend.value,
        );
        if (result.kind === 'ok' && result.written > 0) delivered = true;
        else failure = broadcastFailureMessage(result);
      }
    } else {
      const text =
        currentSource.value.kind === 'library'
          ? render(currentSource.value.text, { values, date })
          : currentSource.value.text;
      const result = await socket.broadcast({ mode: 'selected', termIds: ids }, payloadFor(text, ids), runOnSend.value);
      if (result.kind === 'ok' && result.written > 0) delivered = true;
      else failure = broadcastFailureMessage(result);
    }
    if (!delivered) {
      notices.push(failure ?? t('prompts.notices.notSent'), 'error');
    }
  } finally {
    sending.value = false;
  }
}

function historyText(item: PromptHistoryEvent): string {
  return item.outputText || item.inputText || '';
}

function historyTitle(item: PromptHistoryEvent): string {
  const text = historyText(item).trim();
  if (text) return text.slice(0, 60);
  return item.kind.replaceAll('_', ' ');
}

function onHistorySelect(item: PromptHistoryEvent): void {
  historySelectedId.value = item.id;
  activeTab.value = 'history';
}

async function submitGeneration(input: {
  inputText: string;
  agentType: TigerAgentType;
  model?: string;
  effort?: string;
}): Promise<void> {
  activeTab.value = 'generation';
  await generation.start(input);
}

let unbindHistory: (() => void) | null = null;
let unbindGeneration: (() => void) | null = null;

onMounted(() => {
  setSnapshot();
  void prompts.fetchAll().catch(() => {});
  void history.fetchAll().catch(() => {});
  if (!terminals.loaded) void terminals.fetchAll().catch(() => {});
  if (!groups.loaded) void groups.load().catch(() => {});
  unbindHistory = history.bindSocket();
  unbindGeneration = generation.bindSocket();
});

onBeforeUnmount(() => {
  unbindHistory?.();
  unbindGeneration?.();
});
</script>

<template>
  <div class="prompts-view">
    <header class="phead">
      <div class="brand">
        <b>{{ t('prompts.view.title') }}</b>
        <span>{{ t('prompts.view.subtitle') }}</span>
      </div>
      <span class="spacer" />
      <BaseButton variant="secondary" @click="emit('back')">{{ t('prompts.view.backToTerminals') }}</BaseButton>
    </header>

    <main class="pbody">
      <BaseTabs
        v-model="activeTab"
        class="prompt-tabs"
        :tabs="tabs"
        :label="t('prompts.view.sectionsLabel')"
        id-prefix="prompt-section"
        panel-class="main-panel"
      >
        <template #library>
          <div class="library-panel">
            <section class="library-list">
              <PromptLibrary
                :items="prompts.items"
                :current-path="currentPath"
                :dirty="dirty"
                :loading="prompts.loading && !prompts.loaded"
                :error="prompts.loadError"
                @open="openPrompt"
                @create="resetDraft"
                @remove="removePrompt"
                @rename="renamePrompt"
                @refresh="() => prompts.fetchAll().catch(() => {})"
              />
            </section>
            <section class="library-editor">
              <div class="editor-head">
                <div>
                  <h2>{{ currentPath || t('prompts.view.newLibraryPrompt') }}</h2>
                  <p>{{ dirty ? t('prompts.view.unsaved') : t('prompts.view.saved') }}</p>
                </div>
                <BaseButton variant="ghost" @click="resetDraft">{{ t('common.new') }}</BaseButton>
                <BaseButton variant="primary" :disabled="!dirty" @click="saveLibraryDraft">
                  {{ currentPath ? t('common.save') : t('common.saveAs') }}
                </BaseButton>
              </div>
              <PromptEditor
                :draft="draft"
                :values="values"
                :target-shell-kinds="targetShellKinds"
                @update:draft="(next) => Object.assign(draft, next)"
                @update:value="(name, value) => (values[name] = value)"
              />
            </section>
          </div>
        </template>

        <template #history>
          <PromptHistoryPanel
            :items="history.items"
            :selected-id="historySelectedId"
            :loading="history.loading && !history.loaded"
            :refreshing="history.refreshing"
            :error="history.loadError"
            @refresh="() => history.fetchAll().catch(() => {})"
            @select="onHistorySelect"
          />
        </template>

        <template #generation>
          <PromptGenerationPanel
            :state="generation.current"
            :starting="generation.starting"
            :loading="generation.loading"
            :error="generation.loadError"
            @submit="submitGeneration"
            @select-result="activeTab = 'generation'"
          />
        </template>
      </BaseTabs>

      <aside class="reuse-panel" :aria-label="t('prompts.reuse.actionsLabel')">
        <div class="reuse-head">
          <div>
            <h2>{{ t('prompts.reuse.title') }}</h2>
            <p>{{ currentSource.kind }} / {{ currentSource.status || t('prompts.view.ready') }}</p>
          </div>
          <span class="chars">{{ t('prompts.editor.chars', { n: currentSource.text.length.toLocaleString() }) }}</span>
        </div>

        <EmptyState
          v-if="!hasReusableText"
          :title="t('prompts.reuse.noPromptTitle')"
          :description="t('prompts.reuse.noPromptDescription')"
        />

        <template v-else>
          <div class="source">
            <b>{{ currentSource.title }}</b>
            <pre>{{ currentSource.text }}</pre>
          </div>

          <div class="save-row">
            <input
              v-model="savePath"
              :aria-label="t('prompts.reuse.savePath')"
              :placeholder="t('prompts.reuse.savePathPlaceholder')"
              spellcheck="false"
            />
            <BaseButton variant="secondary" :loading="saving" :disabled="saving" @click="saveReusableText">
              {{ t('common.save') }}
            </BaseButton>
          </div>
          <p v-if="savedPath" class="saved">{{ t('prompts.reuse.savedTo', { path: savedPath }) }}</p>

          <div class="actions">
            <BaseButton variant="secondary" @click="editReusableText">{{ t('prompts.reuse.edit') }}</BaseButton>
            <select v-model="enqueueProvider" :aria-label="t('prompts.reuse.queueProvider')">
              <option value="mixed">{{ t('prompts.reuse.mixedQueue') }}</option>
              <option value="claude">{{ t('prompts.reuse.claudeQueue') }}</option>
              <option value="codex">{{ t('prompts.reuse.codexQueue') }}</option>
              <option value="antigravity">{{ t('prompts.reuse.antigravityQueue') }}</option>
            </select>
            <BaseButton variant="secondary" :loading="enqueuing" :disabled="enqueuing" @click="enqueueReusableText">
              {{ t('common.enqueue') }}
            </BaseButton>
          </div>

          <div class="send-box">
            <div class="send-head">
              <b>{{ t('prompts.reuse.sendToTerminals') }}</b>
              <label><input v-model="runOnSend" type="checkbox" /> {{ t('prompts.reuse.appendEnter') }}</label>
            </div>
            <PromptTargetPicker v-model="selectedTermIds" />
            <BaseButton variant="primary" block :loading="sending" :disabled="!canSend" @click="sendReusableText">
              {{ t('prompts.reuse.sendToCount', { n: selectedTermIds.length }) }}
            </BaseButton>
          </div>
          <p v-if="actionError" class="error">{{ actionError }}</p>
        </template>
      </aside>
    </main>
  </div>
</template>

<style scoped>
.prompts-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.phead {
  height: var(--bar-h);
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 16px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
}
.brand {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.brand b {
  font-size: 15px;
}
.brand span,
.reuse-head p,
.editor-head p,
.hint {
  color: var(--text-dim);
  font-size: 12px;
}
.spacer {
  flex: 1;
}
.pbody {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 14px;
  padding: 14px;
  overflow: hidden;
}
.prompt-tabs {
  min-height: 0;
}
:deep(.main-panel),
.reuse-panel {
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
}
:deep(.main-panel) {
  padding: 14px;
  overflow: hidden;
}
.library-panel {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 14px;
}
.library-list,
.library-editor {
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.editor-head,
.reuse-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 12px;
}
.editor-head h2,
.reuse-head h2 {
  margin: 0;
  font-size: 15px;
}
.editor-head p,
.reuse-head p {
  margin: 3px 0 0;
}
.reuse-panel {
  min-width: 0;
  overflow-y: auto;
  padding: 14px;
}
.chars {
  margin-left: auto;
  font-family: var(--font-mono);
  color: var(--text-faint);
  font-size: 11px;
}
.source {
  display: grid;
  gap: 8px;
}
.source b {
  font-size: 13px;
  line-height: 1.35;
}
pre {
  max-height: 180px;
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px;
}
.save-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  margin-top: 12px;
}
.save-row input {
  font-family: var(--font-mono);
}
.saved {
  margin: 8px 0 0;
  color: var(--green);
  font-size: 12px;
}
.actions {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  margin-top: 12px;
}
.send-box {
  display: grid;
  gap: 10px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.send-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.send-head b {
  font-size: 13px;
}
.send-head label {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-dim);
  font-size: 12px;
}
.hint {
  line-height: 1.45;
}
.error {
  color: var(--red);
  font-size: 12px;
  line-height: 1.45;
}

@media (max-width: 1180px) {
  .pbody,
  .library-panel {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }
  .reuse-panel {
    min-height: 520px;
  }
}
</style>
