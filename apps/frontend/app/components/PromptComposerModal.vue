<script setup lang="ts">
import BaseModal from '~/components/ui/BaseModal.vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import PromptLibrary from './prompt/PromptLibrary.vue';
import PromptEditor, { type PromptDraft } from './prompt/PromptEditor.vue';
import PromptTargetPicker from './prompt/PromptTargetPicker.vue';
import { serializePrompt } from '~/lib/frontmatter';
import { render, hasPerTerminalVars, detectVariables } from '~/lib/promptTemplate';
import { limitFor, strictestLimit } from '~/lib/shellLimits';
import { useT } from '~/composables/useT';
import type { PromptMeta, TerminalDto } from '~/types';
import type { BroadcastOutcome } from '~/composables/useSocket';

const emit = defineEmits<{ close: [] }>();

const { t } = useT();
const prompts = usePromptsStore();
const terminals = useTerminalsStore();
const groups = useGroupsStore();
const conn = useConnectionStore();
const socket = useSocket();
const notices = useNoticesStore();
const dialog = useDialog();

const draft = reactive<PromptDraft>({ title: '', description: '', tagsText: '', target: '', run: false, body: '' });
const values = reactive<Record<string, string>>({});
const selectedTermIds = ref<string[]>([]);
const currentPath = ref<string | null>(null);
const loadedVersion = ref<string | null>(null);
const loadedSnapshot = ref<string>(''); // serialized content at load, for dirty check
const showPreview = ref(false);
const sending = ref(false);

const today = () => new Date().toISOString().slice(0, 10); // evaluated at send/preview time, not mount

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
const content = computed(() => serializePrompt(metaFromDraft(), draft.body));
const dirty = computed(() => content.value !== loadedSnapshot.value);

function isTerminalDto(t: TerminalDto | undefined): t is TerminalDto {
  return Boolean(t);
}
const selectedTerminals = computed(() => selectedTermIds.value.map((id) => terminals.byId[id]).filter(isTerminalDto));
function isSendableTerminal(t: TerminalDto | undefined): t is TerminalDto {
  return Boolean(t && !t.protected);
}
const selectedSendTerminals = computed(() =>
  selectedTermIds.value.map((id) => terminals.byId[id]).filter(isSendableTerminal),
);
const targetShellKinds = computed(() => selectedTerminals.value.map((t) => t.shell?.kind));
const detectedVars = computed(() => detectVariables(draft.body));
const unresolved = computed(() => detectedVars.value.filter((v) => !values[v]?.trim()));

const canSend = computed(
  () =>
    conn.status === 'connected' && selectedTerminals.value.length > 0 && draft.body.trim().length > 0 && !sending.value,
);

function setSnapshot() {
  loadedSnapshot.value = content.value;
}
function resetDraft() {
  Object.assign(draft, { title: '', description: '', tagsText: '', target: '', run: false, body: '' });
  for (const k of Object.keys(values)) delete values[k];
  currentPath.value = null;
  loadedVersion.value = null;
  setSnapshot();
}

// Pre-fill the target picker from a prompt's saved `target` hint.
function applyTargetHint(target?: string) {
  if (!target) return;
  if (target === 'all') selectedTermIds.value = terminals.items.filter((t) => !t.protected).map((t) => t.id);
  else if (target.startsWith('group:')) {
    const name = target.slice(6);
    const g = groups.groups.find((x) => x.name === name);
    if (g) selectedTermIds.value = terminals.items.filter((t) => t.groupId === g.id && !t.protected).map((t) => t.id);
  }
  // 'selected' → leave whatever the user already had
}

function openPrompt(path: string) {
  void guardDirty(() => doOpenPrompt(path));
}
async function doOpenPrompt(path: string) {
  const f = await prompts.open(path);
  if (!f) return;
  Object.assign(draft, {
    title: f.title ?? '',
    description: f.description ?? '',
    tagsText: (f.tags ?? []).join(', '),
    target: f.target ?? '',
    run: f.run ?? false,
    body: f.body,
  });
  for (const k of Object.keys(values)) delete values[k];
  currentPath.value = f.path;
  loadedVersion.value = f.version;
  setSnapshot();
  applyTargetHint(f.target);
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
// Avoid 409 on Save-as by picking the next free name-N.md.
function uniquePath(base: string): string {
  const taken = new Set(prompts.items.map((p) => p.path));
  if (!taken.has(base)) return base;
  const stem = base.replace(/\.md$/i, '');
  for (let i = 2; i < 1000; i++) {
    const cand = `${stem}-${i}.md`;
    if (!taken.has(cand)) return cand;
  }
  return base;
}
async function save() {
  if (!draft.body.trim() && !draft.title.trim()) {
    notices.push(t('prompts.notices.nothingToSave'), 'error');
    return;
  }
  if (currentPath.value) {
    const f = await prompts.update(currentPath.value, content.value, loadedVersion.value ?? undefined);
    if (f) {
      loadedVersion.value = f.version;
      setSnapshot();
      notices.push(t('prompts.notices.promptSaved'));
    }
  } else {
    const path = uniquePath(`${slug(draft.title) || 'untitled'}.md`);
    const f = await prompts.create(path, content.value);
    if (f) {
      currentPath.value = f.path;
      loadedVersion.value = f.version;
      setSnapshot();
      notices.push(t('prompts.notices.savedAs', { path: f.path }));
    }
  }
}
function newDraft() {
  void guardDirty(() => resetDraft());
}
async function onRemove(path: string) {
  if (!(await prompts.remove(path))) return;
  if (currentPath.value === path) resetDraft();
}
async function onRename(from: string, to: string) {
  const dest = to.toLowerCase().endsWith('.md') ? to : `${to}.md`;
  const f = await prompts.rename(from, dest);
  if (f && currentPath.value === from) {
    currentPath.value = f.path;
    loadedVersion.value = f.version;
  }
}

function requestSend() {
  if (!canSend.value) return;
  // Always preview when risky; preview holds the actual dispatch button.
  showPreview.value = true;
}

const previewText = computed(() => {
  const sample = selectedTerminals.value[0];
  return render(draft.body, {
    values,
    terminal: sample ? { name: sample.name, cwd: sample.cwd } : undefined,
    date: today(),
  });
});
const perTerminal = computed(() => hasPerTerminalVars(draft.body));
function summarizeAffectedTargets(names: string[]): string {
  const visible = names.slice(0, 3).join(', ');
  const extra = names.length > 3 ? t('prompts.composer.andMore', { n: names.length - 3 }) : '';
  return `${visible}${extra}`;
}
const promptLengthWarning = computed(() => {
  const targets = selectedSendTerminals.value;
  if (!targets.length) return null;

  const date = today();
  if (perTerminal.value) {
    const affected = targets
      .map((t) => {
        const limit = limitFor(t.shell?.kind);
        const len = render(draft.body, { values, terminal: { name: t.name, cwd: t.cwd }, date }).length;
        return Number.isFinite(limit) && len > limit ? { name: t.name, len, limit } : null;
      })
      .filter((item): item is { name: string; len: number; limit: number } => Boolean(item));

    if (!affected.length) return null;
    const worst = affected.reduce((max, item) => (item.len > max.len ? item : max));
    return t('prompts.composer.lengthWarnPerTerminal', {
      n: affected.length,
      targets: summarizeAffectedTargets(affected.map((item) => item.name)),
      len: worst.len,
      name: worst.name,
      limit: worst.limit,
    });
  }

  const limit = strictestLimit(targets.map((term) => term.shell?.kind));
  const len = render(draft.body, { values, date }).length;
  if (Number.isFinite(limit) && len > limit) {
    return t('prompts.composer.lengthWarnSingle', { len, limit });
  }
  return null;
});

// Shells/REPLs that honor bracketed-paste mode (2004). cmd.exe does NOT, so wrapping there
// would inject a literal "[200~" — only wrap when every target shell supports it.
const BRACKET_OK = new Set(['powershell', 'pwsh', 'bash', 'zsh', 'fish']);
function sanitize(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n') // normalize newlines
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[20[01]~/g, '') // strip any payload-owned bracketed-paste sentinels
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
  ); // drop control chars except \t and \n
}
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
        ? t('prompts.composer.sendFailedServer', {
            message: result.message ?? t('prompts.composer.sendFailedServerDefault'),
          })
        : t('prompts.composer.sendFailedDisconnected');
    case 'timeout':
      return t('prompts.composer.sendStatusTimeout');
    case 'disconnected':
      return t('prompts.composer.sendStatusDisconnected');
  }
}

async function doSend() {
  if (!canSend.value) return;
  sending.value = true;
  try {
    const ids = terminals.unprotectedIds([...selectedTermIds.value]); // protected never receive a send
    const date = today();
    let delivered = false;
    let deliveryFailureMessage: string | null = null;
    let failedCount = 0;
    if (perTerminal.value) {
      for (const id of ids) {
        const t = terminals.byId[id];
        if (!t) continue;
        const txt = render(draft.body, { values, terminal: { name: t.name, cwd: t.cwd }, date });
        const r = await socket.broadcast({ mode: 'selected', termIds: [id] }, payloadFor(txt, [id]), draft.run);
        if (r.kind === 'ok') {
          if (r.written > 0) delivered = true;
        } else {
          deliveryFailureMessage = broadcastFailureMessage(r);
          failedCount += 1;
        }
      }
    } else {
      const txt = render(draft.body, { values, date });
      const r = await socket.broadcast({ mode: 'selected', termIds: ids }, payloadFor(txt, ids), draft.run);
      if (r.kind === 'ok') {
        if (r.written > 0) delivered = true;
      } else {
        deliveryFailureMessage = broadcastFailureMessage(r);
      }
    }
    // Surface cases the per-send toast cannot fully cover.
    if (!delivered) {
      notices.push(deliveryFailureMessage ?? t('prompts.notices.notSent'), 'error');
    } else if (failedCount > 0) {
      // Partial fan-out failure: some terminals got it, others did not. Without this the user
      // would be told nothing failed while part of the per-terminal send was silently lost.
      notices.push(
        t('prompts.composer.partialSendFailed', {
          n: failedCount,
          message: deliveryFailureMessage ?? t('prompts.composer.deliveryFailed'),
        }),
        'error',
      );
    }
    showPreview.value = false;
  } finally {
    sending.value = false;
  }
}

// Dirty guard via the styled, promise-based confirm dialog (no blocking native
// confirm()). When there are unsaved changes, ask before running the action.
async function guardDirty(action: () => void | Promise<void>) {
  if (
    dirty.value &&
    !(await dialog.confirm({
      message: t('terminals.discardChanges'),
      confirmText: t('common.discard'),
      cancelText: t('common.keepEditing'),
      danger: true,
    }))
  ) {
    return;
  }
  await action();
}
function tryClose() {
  void guardDirty(() => emit('close'));
}

onMounted(() => {
  setSnapshot(); // baseline so an untouched composer is not "dirty"
  prompts.fetchAll().catch(() => {});
  if (!terminals.loaded) terminals.fetchAll().catch(() => {});
});
</script>

<template>
  <BaseModal :title="t('prompts.composer.title')" size="xl" @close="tryClose">
    <template #header-actions>
      <BaseButton variant="ghost" @click="newDraft">{{ t('prompts.composer.new') }}</BaseButton>
      <BaseButton variant="primary" :disabled="!dirty" @click="save">{{
        currentPath ? t('common.save') : t('prompts.composer.saveAs')
      }}</BaseButton>
      <BaseButton icon-only variant="ghost" :aria-label="t('common.close')" @click="tryClose">✕</BaseButton>
    </template>

    <div class="composer">
      <div class="cols">
        <section class="col lib-col">
          <PromptLibrary
            :items="prompts.items"
            :current-path="currentPath"
            :dirty="dirty"
            :loading="prompts.loading && !prompts.loaded"
            :error="prompts.loadError"
            @open="openPrompt"
            @create="newDraft"
            @remove="onRemove"
            @rename="onRename"
            @refresh="() => prompts.fetchAll().catch(() => {})"
          />
        </section>
        <section class="col editor-col">
          <PromptEditor
            :draft="draft"
            :values="values"
            :target-shell-kinds="targetShellKinds"
            @update:draft="(next) => Object.assign(draft, next)"
            @update:value="(name, value) => (values[name] = value)"
          />
        </section>
        <section class="col target-col">
          <PromptTargetPicker v-model="selectedTermIds" />
        </section>
      </div>

      <footer class="cfoot">
        <span class="summary">
          <template v-if="selectedTerminals.length">
            {{ t('prompts.composer.sendingTo') }} <b>{{ selectedTerminals.length }}</b
            >:
            {{
              selectedTerminals
                .slice(0, 4)
                .map((term) => term.name)
                .join(', ')
            }}{{ selectedTerminals.length > 4 ? '…' : '' }}
          </template>
          <template v-else>{{ t('prompts.composer.noTargets') }}</template>
          <span class="mode-tag" :class="draft.run ? 'run' : 'paste'">{{
            draft.run ? t('prompts.editor.run') : t('prompts.editor.paste')
          }}</span>
        </span>
        <span v-if="promptLengthWarning" class="length-warn">{{ promptLengthWarning }}</span>
        <BaseButton variant="primary" :disabled="!canSend" @click="requestSend">{{
          t('prompts.composer.previewSend')
        }}</BaseButton>
      </footer>
    </div>

    <!-- Preview / confirm dialog — BaseModal gives Escape-to-close, focus-trap,
         focus-restore, and topmost (teleported) overlay behaviour. -->
    <BaseModal v-if="showPreview" :title="t('prompts.composer.previewTitle')" size="lg" @close="showPreview = false">
      <div class="pmeta">
        <span
          ><b>{{ selectedTerminals.length }}</b> {{ t('prompts.composer.targetsLabel') }}:
          {{ selectedTerminals.map((term) => term.name).join(', ') }}</span
        >
        <span class="mode-tag" :class="draft.run ? 'run' : 'paste'">{{
          draft.run ? t('prompts.composer.runMode') : t('prompts.composer.pasteMode')
        }}</span>
      </div>
      <p v-if="perTerminal" class="note">
        {{ t('prompts.composer.perTerminalNote', { name: selectedTerminals[0]?.name }) }}
      </p>
      <p v-if="unresolved.length" class="warn">
        {{ t('prompts.composer.unfilledVars', { vars: unresolved.join(', ') }) }}
      </p>
      <p v-if="promptLengthWarning" class="warn">{{ promptLengthWarning }}</p>
      <pre class="ptext">{{ previewText }}</pre>
      <template #footer>
        <BaseButton variant="ghost" @click="showPreview = false">{{ t('common.back') }}</BaseButton>
        <BaseButton variant="primary" :loading="sending" :disabled="!canSend" @click="doSend">
          {{ sending ? t('prompts.composer.sending') : t('prompts.composer.sendTo', { n: selectedTerminals.length }) }}
        </BaseButton>
      </template>
    </BaseModal>
  </BaseModal>
</template>

<style scoped>
.composer {
  position: relative;
  display: flex;
  flex-direction: column;
  height: min(660px, 74vh);
}
.cols {
  flex: 1;
  display: grid;
  grid-template-columns: 280px 1fr 300px;
  gap: 14px;
  min-height: 0;
}
.col {
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.cfoot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 12px;
  margin-top: 12px;
  border-top: 1px solid var(--border);
}
.summary {
  font-size: 13px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 10px;
}
.length-warn {
  flex: 1;
  min-width: 180px;
  color: var(--amber);
  font-size: 12px;
  line-height: 1.35;
}
.mode-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 600;
}
.mode-tag.paste {
  background: var(--bg-elev-2);
  color: var(--text-dim);
}
.mode-tag.run {
  background: var(--accent-soft);
  color: var(--accent);
}
.pmeta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--text-dim);
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.note {
  font-size: 12px;
  color: var(--text-dim);
  margin: 4px 0;
}
.warn {
  font-size: 12px;
  color: var(--amber);
  margin: 4px 0;
}
.ptext {
  overflow: auto;
  max-height: 50vh;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 6px 0 0;
}
</style>
