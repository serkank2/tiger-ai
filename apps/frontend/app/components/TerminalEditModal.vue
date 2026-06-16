<script setup lang="ts">
import type { ShellKind, TerminalDto, TerminalInput } from '~/types';

const props = defineProps<{ terminal: TerminalDto | null }>();
const emit = defineEmits<{ close: []; saved: [] }>();

const terminals = useTerminalsStore();
const groups = useGroupsStore();
const settings = useSettingsStore();
const api = useApi();

const SHELLS: { value: ShellKind; label: string }[] = [
  { value: 'system-default', label: 'System default' },
  { value: 'powershell', label: 'Windows PowerShell' },
  { value: 'pwsh', label: 'PowerShell 7 (pwsh)' },
  { value: 'cmd', label: 'Command Prompt (cmd)' },
  { value: 'bash', label: 'bash' },
  { value: 'zsh', label: 'zsh' },
  { value: 'fish', label: 'fish' },
  { value: 'custom', label: 'Custom…' },
];

const isEdit = computed(() => !!props.terminal);

function envToText(env?: Record<string, string>): string {
  return env ? Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') : '';
}
function parseEnv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1);
  }
  return Object.keys(out).length ? out : undefined;
}

const form = reactive({
  name: props.terminal?.name ?? '',
  groupId: props.terminal?.groupId ?? null,
  cwd: props.terminal?.cwd ?? settings.settings?.defaultCwd ?? '',
  initialCommand: props.terminal?.initialCommand ?? '',
  // new terminals inherit the configured default shell
  shellKind: (props.terminal?.shell.kind ?? settings.settings?.defaultShell.kind ?? 'system-default') as ShellKind,
  shellPath: props.terminal?.shell.path ?? settings.settings?.defaultShell.path ?? '',
  shellArgs: (props.terminal?.shell.args ?? []).join(' '),
  env: envToText(props.terminal?.env),
  autostart: props.terminal?.autostart ?? false,
  protected: props.terminal?.protected ?? false,
  // AI CLI quick-start presets — build the initial command (still editable below)
  aiTool: '' as '' | 'claude' | 'codex',
  aiModel: '',
  aiMode: '',
});

// Preset options (flags verified against `claude --help` / `codex --help`).
const CLAUDE_MODELS = ['', 'opus', 'sonnet', 'haiku', 'fable'];
const CLAUDE_MODES: { v: string; label: string }[] = [
  { v: 'default', label: 'Normal — asks each time' },
  { v: 'plan', label: 'Plan mode' },
  { v: 'acceptEdits', label: 'Auto-accept edits' },
  { v: 'full', label: 'Full access (skip all permissions)' },
];
const CODEX_MODES: { v: string; label: string }[] = [
  { v: 'workspace-write', label: 'Workspace write' },
  { v: 'read-only', label: 'Read-only' },
  { v: 'full', label: 'Full access (bypass sandbox + approvals)' },
];
function buildAiCommand(): string {
  if (form.aiTool === 'claude') {
    const p = ['claude'];
    if (form.aiModel) p.push('--model', form.aiModel);
    if (form.aiMode === 'full') p.push('--dangerously-skip-permissions');
    else if (form.aiMode && form.aiMode !== 'default') p.push('--permission-mode', form.aiMode);
    return p.join(' ');
  }
  if (form.aiTool === 'codex') {
    const p = ['codex'];
    if (form.aiModel.trim()) p.push('-m', form.aiModel.trim());
    if (form.aiMode === 'full') p.push('--dangerously-bypass-approvals-and-sandbox');
    else if (form.aiMode) p.push('--sandbox', form.aiMode);
    return p.join(' ');
  }
  return '';
}
function rebuildAi() {
  if (form.aiTool) form.initialCommand = buildAiCommand();
}
function onToolChange() {
  form.aiModel = '';
  form.aiMode = form.aiTool === 'codex' ? 'workspace-write' : form.aiTool === 'claude' ? 'default' : '';
  rebuildAi();
}

const cwdState = ref<'idle' | 'checking' | 'ok' | 'bad'>('idle');
const saving = ref(false);
const error = ref('');

// create-only: make N copies at once, optionally starting them immediately
const count = ref(1);
const startNow = ref(false);
const showPicker = ref(false);
function onPickFolder(p: string) {
  form.cwd = p;
  showPicker.value = false;
  void checkCwd();
}

async function checkCwd() {
  const p = form.cwd.trim();
  if (!p) {
    cwdState.value = 'idle';
    return;
  }
  cwdState.value = 'checking';
  try {
    const r = await api.validatePath(p);
    cwdState.value = r.exists && r.isDirectory ? 'ok' : 'bad';
  } catch {
    cwdState.value = 'bad';
  }
}

async function save() {
  error.value = '';
  if (!form.name.trim()) {
    error.value = 'Name is required.';
    return;
  }
  if (form.shellKind === 'custom' && !form.shellPath.trim()) {
    error.value = 'A custom shell needs a path.';
    return;
  }
  if (cwdState.value === 'bad') {
    error.value = 'Working directory does not exist.';
    return;
  }
  saving.value = true;
  const shell =
    form.shellKind === 'custom'
      ? {
          kind: 'custom' as const,
          path: form.shellPath.trim(),
          args: form.shellArgs.trim() ? form.shellArgs.trim().split(/\s+/) : undefined,
        }
      : { kind: form.shellKind };

  const body: TerminalInput = {
    name: form.name.trim(),
    groupId: form.groupId,
    cwd: form.cwd.trim() || (settings.settings?.defaultCwd ?? ''),
    initialCommand: form.initialCommand.trim() || undefined,
    shell,
    env: parseEnv(form.env),
    autostart: form.autostart,
    protected: form.protected,
  };

  try {
    if (props.terminal) {
      await terminals.update(props.terminal.id, body);
    } else {
      const n = Math.min(Math.max(1, Math.floor(count.value) || 1), 20);
      for (let i = 0; i < n; i++) {
        const dto = await terminals.create({ ...body, name: n > 1 ? `${body.name} ${i + 1}` : body.name });
        if (startNow.value) await terminals.start(dto.id);
      }
    }
    emit('saved');
    emit('close');
  } catch (e) {
    const err = e as { data?: { error?: { message?: string } }; message?: string };
    error.value = err?.data?.error?.message ?? err?.message ?? 'Save failed.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="backdrop" @keydown.esc="emit('close')">
    <div class="modal" role="dialog" aria-modal="true">
      <h2>{{ isEdit ? 'Edit terminal' : 'New terminal' }}</h2>

      <label class="field">
        <span>Name</span>
        <input v-model="form.name" placeholder="e.g. Frontend Claude" autofocus />
      </label>

      <label class="field">
        <span>Group</span>
        <select v-model="form.groupId">
          <option :value="null">— none —</option>
          <option v-for="g in groups.groups" :key="g.id" :value="g.id">{{ g.name }}</option>
        </select>
      </label>

      <label class="field">
        <span>Working directory</span>
        <span class="cwd-row">
          <input v-model="form.cwd" placeholder="C:\path\to\project" spellcheck="false" @blur="checkCwd" />
          <button type="button" class="browse" title="Browse folders" @click="showPicker = true">📁</button>
          <span class="flag" :class="cwdState">
            {{ cwdState === 'ok' ? '✓' : cwdState === 'bad' ? '✗' : cwdState === 'checking' ? '…' : '' }}
          </span>
        </span>
      </label>

      <div class="ai">
        <div class="ai-head">🤖 AI CLI quick start <i>(fills the initial command — still editable)</i></div>
        <div class="ai-row">
          <select v-model="form.aiTool" aria-label="AI CLI" @change="onToolChange">
            <option value="">— none —</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
          <template v-if="form.aiTool === 'claude'">
            <select v-model="form.aiModel" aria-label="Claude model" @change="rebuildAi">
              <option v-for="m in CLAUDE_MODELS" :key="m" :value="m">{{ m || 'default model' }}</option>
            </select>
            <select v-model="form.aiMode" aria-label="Claude permission mode" @change="rebuildAi">
              <option v-for="o in CLAUDE_MODES" :key="o.v" :value="o.v">{{ o.label }}</option>
            </select>
          </template>
          <template v-else-if="form.aiTool === 'codex'">
            <input v-model="form.aiModel" placeholder="model (optional)" spellcheck="false" @input="rebuildAi" />
            <select v-model="form.aiMode" aria-label="Codex sandbox mode" @change="rebuildAi">
              <option v-for="o in CODEX_MODES" :key="o.v" :value="o.v">{{ o.label }}</option>
            </select>
          </template>
        </div>
        <p v-if="form.aiMode === 'full'" class="ai-warn">
          ⚠ Full access bypasses all {{ form.aiTool === 'claude' ? 'permission prompts' : 'sandbox + approval checks' }}.
        </p>
      </div>

      <label class="field">
        <span>Initial command <i>(optional)</i></span>
        <input v-model="form.initialCommand" placeholder="npm run dev · claude · codex" spellcheck="false" />
      </label>

      <label class="field">
        <span>Shell</span>
        <select v-model="form.shellKind">
          <option v-for="s in SHELLS" :key="s.value" :value="s.value">{{ s.label }}</option>
        </select>
      </label>

      <template v-if="form.shellKind === 'custom'">
        <label class="field">
          <span>Shell path</span>
          <input v-model="form.shellPath" placeholder="C:\path\to\shell.exe" spellcheck="false" />
        </label>
        <label class="field">
          <span>Shell args <i>(space-separated)</i></span>
          <input v-model="form.shellArgs" spellcheck="false" />
        </label>
      </template>

      <label class="field">
        <span>Environment variables <i>(KEY=VALUE per line, optional)</i></span>
        <textarea v-model="form.env" rows="3" spellcheck="false" placeholder="NODE_ENV=development" />
      </label>

      <label class="check">
        <input v-model="form.autostart" type="checkbox" />
        <span>Auto-start when Kaplan launches</span>
      </label>
      <label class="check">
        <input v-model="form.protected" type="checkbox" />
        <span>🔒 Protected — exclude from bulk &amp; fan-out (all/group) commands</span>
      </label>

      <template v-if="!isEdit">
        <label class="field">
          <span>How many <i>(create this many at once)</i></span>
          <input v-model.number="count" type="number" min="1" max="20" />
        </label>
        <label class="check">
          <input v-model="startNow" type="checkbox" />
          <span>Start them immediately after creating</span>
        </label>
      </template>

      <p v-if="error" class="err">{{ error }}</p>

      <div class="foot">
        <button class="ghost" @click="emit('close')">Cancel</button>
        <button class="primary" :disabled="saving" @click="save">
          {{ saving ? 'Saving…' : isEdit ? 'Save changes' : count > 1 ? `Create ${count}` : 'Create' }}
        </button>
      </div>
    </div>
  </div>

  <FolderPicker v-if="showPicker" :initial="form.cwd" @select="onPickFolder" @close="showPicker = false" />
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: grid;
  place-items: center;
  z-index: 50;
  backdrop-filter: blur(2px);
}
.modal {
  width: min(720px, 95vw);
  max-height: 92vh;
  overflow-y: auto;
  background: var(--bg-elev);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 22px 24px;
}
h2 {
  margin: 0 0 16px;
  font-size: 18px;
}
.field {
  display: block;
  margin-bottom: 13px;
}
.field > span {
  display: block;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 5px;
}
.field i {
  color: var(--text-faint);
  font-style: normal;
}
.field input,
.field select,
.field textarea {
  width: 100%;
}
.field textarea {
  font-family: var(--font-mono);
  font-size: 12px;
  resize: vertical;
}
.ai {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  margin-bottom: 13px;
  background: var(--bg);
}
.ai-head {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 8px;
}
.ai-head i {
  color: var(--text-faint);
  font-style: normal;
}
.ai-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.ai-row select,
.ai-row input {
  flex: 1;
  min-width: 130px;
  font-size: 12px;
}
.ai-warn {
  color: var(--amber);
  font-size: 11px;
  margin: 8px 0 0;
}
.cwd-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cwd-row input {
  flex: 1;
  font-family: var(--font-mono);
}
.browse {
  flex: none;
  width: 38px;
  height: 34px;
  border: 1px solid var(--border-strong);
}
.browse:hover {
  border-color: var(--accent);
}
.flag {
  width: 20px;
  text-align: center;
  font-weight: 700;
}
.flag.ok {
  color: var(--green);
}
.flag.bad {
  color: var(--red);
}
.check {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 16px 0;
  font-size: 13px;
  color: var(--text-dim);
}
.check input {
  accent-color: var(--accent);
}
.err {
  color: var(--red);
  font-size: 13px;
  margin: 6px 0 0;
}
.foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
.ghost {
  border: 1px solid var(--border-strong);
  padding: 8px 16px;
  color: var(--text-dim);
}
.ghost:hover {
  color: var(--text);
}
.primary {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #1b1206;
  font-weight: 700;
  padding: 8px 18px;
}
.primary:hover:not(:disabled) {
  background: var(--accent-strong);
}
.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
