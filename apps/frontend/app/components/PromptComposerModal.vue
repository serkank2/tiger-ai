<script setup lang="ts">
import PromptLibrary from './prompt/PromptLibrary.vue';
import PromptEditor, { type PromptDraft } from './prompt/PromptEditor.vue';
import PromptTargetPicker from './prompt/PromptTargetPicker.vue';
import { serializePrompt } from '~/lib/frontmatter';
import { render, hasPerTerminalVars, detectVariables } from '~/lib/promptTemplate';
import type { PromptMeta } from '~/types';

const emit = defineEmits<{ close: [] }>();

const prompts = usePromptsStore();
const terminals = useTerminalsStore();
const groups = useGroupsStore();
const conn = useConnectionStore();
const socket = useSocket();
const notices = useNoticesStore();

const draft = reactive<PromptDraft>({ title: '', description: '', tagsText: '', target: '', run: false, body: '' });
const values = reactive<Record<string, string>>({});
const selectedTermIds = ref<string[]>([]);
const currentPath = ref<string | null>(null);
const loadedVersion = ref<string | null>(null);
const loadedSnapshot = ref<string>(''); // serialized content at load, for dirty check
const showPreview = ref(false);
const confirmDiscard = ref(false);
const pendingAction = ref<null | (() => void | Promise<void>)>(null);
const sending = ref(false);

const today = () => new Date().toISOString().slice(0, 10); // evaluated at send/preview time, not mount

function parseTags(text: string): string[] {
  return text.split(',').map((s) => s.trim()).filter(Boolean);
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

const selectedTerminals = computed(() => selectedTermIds.value.map((id) => terminals.byId[id]).filter(Boolean));
const targetShellKinds = computed(() => selectedTerminals.value.map((t) => t.shell?.kind));
const detectedVars = computed(() => detectVariables(draft.body));
const unresolved = computed(() => detectedVars.value.filter((v) => !values[v]?.trim()));

const canSend = computed(
  () => conn.status === 'connected' && selectedTerminals.value.length > 0 && draft.body.trim().length > 0 && !sending.value,
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
  guardDirty(() => doOpenPrompt(path));
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
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
    notices.push('Nothing to save', 'error');
    return;
  }
  if (currentPath.value) {
    const f = await prompts.update(currentPath.value, content.value, loadedVersion.value ?? undefined);
    if (f) {
      loadedVersion.value = f.version;
      setSnapshot();
      notices.push('Prompt saved');
    }
  } else {
    const path = uniquePath(`${slug(draft.title) || 'untitled'}.md`);
    const f = await prompts.create(path, content.value);
    if (f) {
      currentPath.value = f.path;
      loadedVersion.value = f.version;
      setSnapshot();
      notices.push(`Saved as ${f.path}`);
    }
  }
}
function newDraft() {
  guardDirty(() => resetDraft());
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

// Shells/REPLs that honor bracketed-paste mode (2004). cmd.exe does NOT, so wrapping there
// would inject a literal "[200~" — only wrap when every target shell supports it.
const BRACKET_OK = new Set(['powershell', 'pwsh', 'bash', 'zsh', 'fish']);
function sanitize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n') // normalize newlines
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[20[01]~/g, '') // strip any payload-owned bracketed-paste sentinels
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); // drop control chars except \t and \n
}
function payloadFor(text: string, ids: string[]): string {
  const safe = sanitize(text);
  const bracket = safe.includes('\n') && ids.length > 0 && ids.every((id) => BRACKET_OK.has(terminals.byId[id]?.shell?.kind ?? ''));
  return bracket ? `\x1b[200~${safe}\x1b[201~` : safe;
}

async function doSend() {
  if (!canSend.value) return;
  sending.value = true;
  try {
    const ids = terminals.unprotectedIds([...selectedTermIds.value]); // protected never receive a send
    const date = today();
    let delivered = false;
    if (perTerminal.value) {
      for (const id of ids) {
        const t = terminals.byId[id];
        if (!t) continue;
        const txt = render(draft.body, { values, terminal: { name: t.name, cwd: t.cwd }, date });
        const r = await socket.broadcast({ mode: 'selected', termIds: [id] }, payloadFor(txt, [id]), draft.run);
        if (r && r.written > 0) delivered = true;
      }
    } else {
      const txt = render(draft.body, { values, date });
      const r = await socket.broadcast({ mode: 'selected', termIds: ids }, payloadFor(txt, ids), draft.run);
      if (r && r.written > 0) delivered = true;
    }
    // Surface the silent-failure case the per-send toast doesn't cover (socket closed → null result).
    if (!delivered) notices.push('Not sent — no terminal received it (disconnected or not running)', 'error');
    showPreview.value = false;
  } finally {
    sending.value = false;
  }
}

// Inline (non-native) dirty guard — a native confirm() blocks/freezes the page.
// Stash the intended action; the confirm overlay then runs or cancels it.
function guardDirty(action: () => void | Promise<void>) {
  if (dirty.value) {
    pendingAction.value = action;
    confirmDiscard.value = true;
  } else {
    void action();
  }
}
function confirmDiscardYes() {
  const action = pendingAction.value;
  confirmDiscard.value = false;
  pendingAction.value = null;
  if (action) void action();
}
function confirmDiscardNo() {
  confirmDiscard.value = false;
  pendingAction.value = null;
}
function tryClose() {
  guardDirty(() => emit('close'));
}

onMounted(() => {
  setSnapshot(); // baseline so an untouched composer is not "dirty"
  prompts.fetchAll().catch(() => {});
  if (!terminals.loaded) terminals.fetchAll().catch(() => {});
});
</script>

<template>
  <div class="backdrop" @keydown.esc="tryClose">
    <div class="modal" role="dialog" aria-modal="true">
      <header class="head">
        <h2>Prompt Composer</h2>
        <div class="head-actions">
          <button class="ghost" @click="newDraft">+ New</button>
          <button class="primary" :disabled="!dirty" @click="save">{{ currentPath ? 'Save' : 'Save as…' }}</button>
          <button class="x" aria-label="Close" @click="tryClose">✕</button>
        </div>
      </header>

      <div class="cols">
        <section class="col lib-col">
          <PromptLibrary
            :items="prompts.items"
            :current-path="currentPath"
            :dirty="dirty"
            @open="openPrompt"
            @create="newDraft"
            @remove="onRemove"
            @rename="onRename"
            @refresh="() => prompts.fetchAll().catch(() => {})"
          />
        </section>
        <section class="col editor-col">
          <PromptEditor :draft="draft" :values="values" :target-shell-kinds="targetShellKinds" />
        </section>
        <section class="col target-col">
          <PromptTargetPicker v-model="selectedTermIds" />
        </section>
      </div>

      <footer class="foot">
        <span class="summary">
          <template v-if="selectedTerminals.length">
            Sending to <b>{{ selectedTerminals.length }}</b>:
            {{ selectedTerminals.slice(0, 4).map((t) => t.name).join(', ') }}{{ selectedTerminals.length > 4 ? '…' : '' }}
          </template>
          <template v-else>No targets selected</template>
          <span class="mode-tag" :class="draft.run ? 'run' : 'paste'">{{ draft.run ? 'Run ⏎' : 'Paste' }}</span>
        </span>
        <button class="primary send" :disabled="!canSend" @click="requestSend">Preview &amp; Send</button>
      </footer>

      <!-- Preview / confirm overlay -->
      <div v-if="showPreview" class="preview-overlay" @click.self="showPreview = false">
        <div class="preview">
          <h3>Preview</h3>
          <div class="pmeta">
            <span><b>{{ selectedTerminals.length }}</b> target(s): {{ selectedTerminals.map((t) => t.name).join(', ') }}</span>
            <span class="mode-tag" :class="draft.run ? 'run' : 'paste'">{{ draft.run ? 'Run (Enter appended)' : 'Paste (no Enter)' }}</span>
          </div>
          <p v-if="perTerminal" class="note">Built-ins vary per terminal — showing "{{ selectedTerminals[0]?.name }}".</p>
          <p v-if="unresolved.length" class="warn">⚠ Unfilled variables: {{ unresolved.join(', ') }} (will send as-is)</p>
          <pre class="ptext">{{ previewText }}</pre>
          <div class="pfoot">
            <button class="ghost" @click="showPreview = false">Back</button>
            <button class="primary" :disabled="!canSend" @click="doSend">{{ sending ? 'Sending…' : `Send to ${selectedTerminals.length}` }}</button>
          </div>
        </div>
      </div>

      <!-- Discard-changes confirm -->
      <div v-if="confirmDiscard" class="preview-overlay">
        <div class="preview small">
          <p>Discard unsaved changes?</p>
          <div class="pfoot">
            <button class="ghost" @click="confirmDiscardNo">Keep editing</button>
            <button class="primary danger" @click="confirmDiscardYes">Discard</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); display: grid; place-items: center; z-index: 50; backdrop-filter: blur(2px); }
.modal { width: min(1180px, 96vw); height: min(780px, 92vh); display: flex; flex-direction: column; background: var(--bg-elev); border: 1px solid var(--border-strong); border-radius: var(--radius); box-shadow: var(--shadow); }
.head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--border); }
.head h2 { margin: 0; font-size: 17px; }
.head-actions { display: flex; gap: 8px; align-items: center; }
.cols { flex: 1; display: grid; grid-template-columns: 280px 1fr 300px; gap: 14px; padding: 14px 18px; min-height: 0; }
.col { min-height: 0; display: flex; flex-direction: column; }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 18px; border-top: 1px solid var(--border); }
.summary { font-size: 13px; color: var(--text-dim); display: flex; align-items: center; gap: 10px; }
.mode-tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
.mode-tag.paste { background: var(--bg-elev-2); color: var(--text-dim); }
.mode-tag.run { background: var(--accent-soft); color: var(--accent); }
.primary { border: 1px solid var(--accent); background: var(--accent); color: #1b1206; font-weight: 700; padding: 7px 16px; }
.primary:disabled { opacity: 0.45; cursor: not-allowed; }
.primary.danger { border-color: var(--red); background: var(--red); }
.send { padding: 9px 20px; }
.ghost { border: 1px solid var(--border-strong); padding: 7px 14px; color: var(--text-dim); }
.x { width: 30px; height: 30px; color: var(--text-dim); font-size: 14px; }
.x:hover { color: var(--text); }
.preview-overlay { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.5); display: grid; place-items: center; border-radius: var(--radius); }
.preview { width: min(680px, 90%); max-height: 86%; display: flex; flex-direction: column; background: var(--bg-elev); border: 1px solid var(--border-strong); border-radius: var(--radius); padding: 18px 20px; box-shadow: var(--shadow); }
.preview.small { width: auto; }
.preview h3 { margin: 0 0 10px; }
.pmeta { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-dim); margin-bottom: 8px; flex-wrap: wrap; }
.note { font-size: 12px; color: var(--text-dim); margin: 4px 0; }
.warn { font-size: 12px; color: var(--amber); margin: 4px 0; }
.ptext { flex: 1; overflow: auto; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; word-break: break-word; margin: 6px 0 12px; }
.pfoot { display: flex; justify-content: flex-end; gap: 10px; }
</style>
