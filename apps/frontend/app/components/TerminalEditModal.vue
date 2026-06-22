<script setup lang="ts">
import type { ShellKind, TerminalDto, TerminalInput } from '~/types';
import BaseModal from '~/components/ui/BaseModal.vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import BaseField from '~/components/ui/BaseField.vue';
import { errText } from '~/lib/apiError';
import {
  absoluteLocalPathError,
  customShellPathError,
  envTextError,
  usesWindowsPathSyntax,
} from '~/lib/formValidation';
import { INITIAL_COMMAND_MAX_LENGTH } from '~/lib/shellLimits';

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
  aiTool: '' as '' | 'claude' | 'codex' | 'antigravity',
  aiModel: '',
  aiMode: '',
});

// Preset options (flags verified against `claude --help` / `codex --help` / `agy -h`).
const CLAUDE_MODELS = ['', 'opus', 'sonnet', 'haiku', 'fable'];
// Antigravity models are exact labels from `agy models` (they contain spaces/parentheses).
const ANTIGRAVITY_MODELS = [
  '',
  'Gemini 3.5 Flash (Medium)',
  'Gemini 3.5 Flash (High)',
  'Gemini 3.5 Flash (Low)',
  'Gemini 3.1 Pro (Low)',
  'Gemini 3.1 Pro (High)',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)',
  'GPT-OSS 120B (Medium)',
];
const ANTIGRAVITY_MODES: { v: string; label: string }[] = [
  { v: 'default', label: 'Normal — asks each time' },
  { v: 'sandbox', label: 'Sandbox (terminal restricted)' },
  { v: 'full', label: 'Full access (skip all permissions)' },
];
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
  if (form.aiTool === 'antigravity') {
    const p = ['agy'];
    // Antigravity model labels contain spaces/parentheses — double-quote so they pass as one arg.
    if (form.aiModel.trim()) p.push('--model', `"${form.aiModel.trim()}"`);
    if (form.aiMode === 'full') p.push('--dangerously-skip-permissions');
    else if (form.aiMode === 'sandbox') p.push('--sandbox');
    return p.join(' ');
  }
  return '';
}
function rebuildAi() {
  if (form.aiTool) {
    form.initialCommand = buildAiCommand();
    clearServerError('initialCommand');
  }
}
function onToolChange() {
  form.aiModel = '';
  form.aiMode =
    form.aiTool === 'codex'
      ? 'workspace-write'
      : form.aiTool === 'claude' || form.aiTool === 'antigravity'
        ? 'default'
        : '';
  rebuildAi();
}

const cwdState = ref<'idle' | 'checking' | 'ok' | 'bad'>('idle');
const saving = ref(false);
const error = ref('');

type FieldKey = 'name' | 'groupId' | 'cwd' | 'initialCommand' | 'shellPath' | 'env';
const serverErrors = reactive<Partial<Record<FieldKey, string>>>({});
function clearServerError(field: FieldKey) {
  delete serverErrors[field];
  error.value = '';
}
function clearServerErrors() {
  for (const key of Object.keys(serverErrors) as FieldKey[]) delete serverErrors[key];
}
function applyServerError(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes('name')) serverErrors.name = message;
  else if (lower.includes('groupid')) serverErrors.groupId = message;
  else if (lower.includes('working directory')) serverErrors.cwd = message;
  else if (lower.includes('initialcommand')) serverErrors.initialCommand = message;
  else if (lower.includes('shell')) serverErrors.shellPath = message;
  else if (lower.includes('env')) serverErrors.env = message;
  else error.value = message;
}

const cwdWindowsContext = computed(() => usesWindowsPathSyntax(settings.settings?.defaultCwd, form.cwd));
const shellWindowsContext = computed(() =>
  usesWindowsPathSyntax(settings.settings?.defaultCwd, form.cwd, form.shellPath),
);
const nameError = computed(() => serverErrors.name ?? (!form.name.trim() ? 'Name is required.' : null));
const groupError = computed(() =>
  serverErrors.groupId ?? (form.groupId && !groups.groups.some((g) => g.id === form.groupId) ? 'Choose an existing group.' : null),
);
const cwdShapeError = computed(() =>
  form.cwd.trim() ? absoluteLocalPathError(form.cwd, 'Working directory', cwdWindowsContext.value) : null,
);
const cwdError = computed(
  () => serverErrors.cwd ?? cwdShapeError.value ?? (cwdState.value === 'bad' ? 'Working directory does not exist or is not a folder.' : null),
);
const initialCommandLength = computed(() => form.initialCommand.trim().length);
const initialCommandError = computed(() =>
  serverErrors.initialCommand ??
  (initialCommandLength.value > INITIAL_COMMAND_MAX_LENGTH
    ? `Initial command must be ${INITIAL_COMMAND_MAX_LENGTH} characters or fewer.`
    : null),
);
const shellPathError = computed(() =>
  serverErrors.shellPath ?? customShellPathError(form.shellKind, form.shellPath, 'Shell path', shellWindowsContext.value),
);
const envError = computed(() => serverErrors.env ?? envTextError(form.env));
const hasFieldError = computed(() =>
  Boolean(nameError.value || groupError.value || cwdError.value || initialCommandError.value || shellPathError.value || envError.value),
);
const canSave = computed(() => !saving.value && !hasFieldError.value && cwdState.value !== 'checking');

watch(() => form.initialCommand, () => clearServerError('initialCommand'));
watch(() => form.shellPath, () => clearServerError('shellPath'));
watch(() => form.env, () => clearServerError('env'));

// create-only: make N copies at once, optionally starting them immediately
const count = ref(1);
const startNow = ref(false);
const showPicker = ref(false);
function onPickFolder(p: string) {
  form.cwd = p;
  clearServerError('cwd');
  showPicker.value = false;
  void checkCwd();
}

function onCwdInput() {
  clearServerError('cwd');
  cwdState.value = 'idle';
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
  clearServerErrors();
  if (form.cwd.trim() && !cwdShapeError.value) await checkCwd();
  if (hasFieldError.value || cwdState.value === 'checking') return;

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
    applyServerError(errText(e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <BaseModal :title="isEdit ? 'Edit terminal' : 'New terminal'" size="lg" @close="emit('close')">
      <BaseField id="terminal-name" v-slot="{ id, describedby, invalid }" label="Name" :error="nameError || undefined">
        <input
          :id="id"
          v-model="form.name"
          :placeholder="t('terminals.placeholders.nameExample')"
          autofocus
          :aria-invalid="invalid || undefined"
          :aria-describedby="describedby"
          @input="clearServerError('name')"
        />
      </BaseField>

      <BaseField id="terminal-group" v-slot="{ id, describedby, invalid }" label="Group" :error="groupError || undefined">
        <select
          :id="id"
          v-model="form.groupId"
          :aria-invalid="invalid || undefined"
          :aria-describedby="describedby"
          @change="clearServerError('groupId')"
        >
          <option :value="null">— none —</option>
          <option v-for="g in groups.groups" :key="g.id" :value="g.id">{{ g.name }}</option>
        </select>
      </BaseField>

      <BaseField id="terminal-cwd" v-slot="{ id, describedby, invalid }" label="Working directory" :error="cwdError || undefined">
        <span class="cwd-row">
          <input
            :id="id"
            v-model="form.cwd"
            placeholder="C:\path\to\project"
            spellcheck="false"
            :aria-invalid="invalid || undefined"
            :aria-describedby="describedby"
            @input="onCwdInput"
            @blur="checkCwd"
          />
          <button type="button" class="browse" :title="t('settings.browseFolders')" :aria-label="t('settings.browseFolders')" @click="showPicker = true">📁</button>
          <span class="flag" :class="cwdState">
            {{ cwdState === 'ok' ? '✓' : cwdState === 'bad' ? '✗' : cwdState === 'checking' ? '…' : '' }}
          </span>
        </span>
      </BaseField>

      <div class="ai">
        <div class="ai-head">🤖 AI CLI quick start <i>(fills the initial command — still editable)</i></div>
        <div class="ai-row">
          <select v-model="form.aiTool" aria-label="AI CLI" @change="onToolChange">
            <option value="">— none —</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="antigravity">Antigravity</option>
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
            <input v-model="form.aiModel" :placeholder="t('terminals.placeholders.modelOptional')" spellcheck="false" @input="rebuildAi" />
            <select v-model="form.aiMode" aria-label="Codex sandbox mode" @change="rebuildAi">
              <option v-for="o in CODEX_MODES" :key="o.v" :value="o.v">{{ o.label }}</option>
            </select>
          </template>
          <template v-else-if="form.aiTool === 'antigravity'">
            <select v-model="form.aiModel" aria-label="Antigravity model" @change="rebuildAi">
              <option v-for="m in ANTIGRAVITY_MODELS" :key="m" :value="m">{{ m || 'default model' }}</option>
            </select>
            <select v-model="form.aiMode" aria-label="Antigravity permission mode" @change="rebuildAi">
              <option v-for="o in ANTIGRAVITY_MODES" :key="o.v" :value="o.v">{{ o.label }}</option>
            </select>
          </template>
        </div>
        <p v-if="form.aiMode === 'full'" class="ai-warn">
          ⚠ Full access bypasses all
          {{ form.aiTool === 'codex' ? 'sandbox + approval checks' : 'permission prompts' }}.
        </p>
      </div>

      <BaseField
        label="Initial command"
        :hint="`optional, ${initialCommandLength}/${INITIAL_COMMAND_MAX_LENGTH}`"
        :error="initialCommandError || undefined"
      >
        <input v-model="form.initialCommand" placeholder="npm run dev · claude · codex" spellcheck="false" />
      </BaseField>

      <label class="field">
        <span>Shell</span>
        <select v-model="form.shellKind" @change="clearServerError('shellPath')">
          <option v-for="s in SHELLS" :key="s.value" :value="s.value">{{ s.label }}</option>
        </select>
      </label>

      <template v-if="form.shellKind === 'custom'">
        <BaseField id="terminal-shell-path" v-slot="{ id, describedby, invalid }" label="Shell path" :error="shellPathError || undefined">
          <input
            :id="id"
            v-model="form.shellPath"
            placeholder="C:\path\to\shell.exe"
            spellcheck="false"
            :aria-invalid="invalid || undefined"
            :aria-describedby="describedby"
          />
        </BaseField>
        <label class="field">
          <span>Shell args <i>(space-separated)</i></span>
          <input v-model="form.shellArgs" spellcheck="false" />
        </label>
      </template>

      <BaseField
        id="terminal-env"
        v-slot="{ id, describedby, invalid }"
        label="Environment variables"
        hint="KEY=VALUE per line, optional"
        :error="envError || undefined"
      >
        <textarea
          :id="id"
          v-model="form.env"
          rows="3"
          spellcheck="false"
          placeholder="NODE_ENV=development"
          :aria-invalid="invalid || undefined"
          :aria-describedby="describedby"
        />
      </BaseField>

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

      <template #footer>
        <BaseButton variant="ghost" @click="emit('close')">Cancel</BaseButton>
        <BaseButton variant="primary" :loading="saving" :disabled="!canSave" @click="save">
          {{ isEdit ? 'Save changes' : count > 1 ? `Create ${count}` : 'Create' }}
        </BaseButton>
      </template>
  </BaseModal>

  <FolderPicker v-if="showPicker" :initial="form.cwd" @select="onPickFolder" @close="showPicker = false" />
</template>

<style scoped>
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
</style>
