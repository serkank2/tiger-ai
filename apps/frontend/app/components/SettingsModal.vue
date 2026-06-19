<script setup lang="ts">
import type { AppSettings, ShellKind } from '~/types';
import BaseModal from '~/components/ui/BaseModal.vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import BaseField from '~/components/ui/BaseField.vue';
import { errText } from '~/lib/apiError';
import { absoluteLocalPathError, customShellPathError, usesWindowsPathSyntax } from '~/lib/formValidation';

const emit = defineEmits<{ close: [] }>();
const settings = useSettingsStore();
const theme = useThemeStore();
const notices = useNoticesStore();
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

const s = settings.settings;
const form = reactive({
  defaultCwd: s?.defaultCwd ?? '',
  shellKind: (s?.defaultShell.kind ?? 'system-default') as ShellKind,
  shellPath: s?.defaultShell.path ?? '',
  appendNewlineByDefault: s?.commandRouting.appendNewlineByDefault ?? true,
  startTerminalOnSend: s?.commandRouting.startTerminalOnSend ?? false,
  authToken: settings.authToken ?? '',
});

const cwdState = ref<'idle' | 'checking' | 'ok' | 'bad'>('idle');
const saving = ref(false);
const error = ref('');
const showPicker = ref(false);

type FieldKey = 'defaultCwd' | 'shellPath';
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
  if (lower.includes('defaultcwd') || lower.includes('working directory')) serverErrors.defaultCwd = message;
  else if (lower.includes('defaultshell') || lower.includes('shell')) serverErrors.shellPath = message;
  else error.value = message;
}

const cwdWindowsContext = computed(() => usesWindowsPathSyntax(settings.settings?.defaultCwd, form.defaultCwd));
const defaultCwdShapeError = computed(() =>
  form.defaultCwd.trim() ? absoluteLocalPathError(form.defaultCwd, 'Default working directory', cwdWindowsContext.value) : null,
);
const defaultCwdError = computed(
  () =>
    serverErrors.defaultCwd ??
    defaultCwdShapeError.value ??
    (cwdState.value === 'bad' ? 'Default working directory does not exist or is not a folder.' : null),
);
const shellWindowsContext = computed(() =>
  usesWindowsPathSyntax(settings.settings?.defaultCwd, form.defaultCwd, form.shellPath),
);
const shellPathError = computed(() =>
  serverErrors.shellPath ?? customShellPathError(form.shellKind, form.shellPath, 'Default shell path', shellWindowsContext.value),
);
const hasFieldError = computed(() => Boolean(defaultCwdError.value || shellPathError.value));
const canSave = computed(() => !saving.value && !hasFieldError.value && cwdState.value !== 'checking');

function onPickFolder(p: string) {
  form.defaultCwd = p;
  clearServerError('defaultCwd');
  showPicker.value = false;
  void checkCwd();
}

function onCwdInput() {
  clearServerError('defaultCwd');
  cwdState.value = 'idle';
}

async function checkCwd() {
  const p = form.defaultCwd.trim();
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
  // Client-only, persisted to localStorage — independent of server-side settings validation.
  settings.setAuthToken(form.authToken);
  if (form.defaultCwd.trim() && !defaultCwdShapeError.value) await checkCwd();
  if (hasFieldError.value || cwdState.value === 'checking') return;

  saving.value = true;
  const defaultShell =
    form.shellKind === 'custom'
      ? { kind: 'custom' as const, path: form.shellPath.trim() }
      : { kind: form.shellKind };
  const patch: Partial<AppSettings> = {
    defaultShell,
    commandRouting: {
      appendNewlineByDefault: form.appendNewlineByDefault,
      startTerminalOnSend: form.startTerminalOnSend,
    },
  };
  if (form.defaultCwd.trim()) patch.defaultCwd = form.defaultCwd.trim();

  try {
    await settings.update(patch);
    notices.push('Settings saved');
    emit('close');
  } catch (e) {
    applyServerError(errText(e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <BaseModal title="Settings" size="md" @close="emit('close')">
      <div class="field">
        <span>Theme <i>(applies instantly)</i></span>
        <div class="themes">
          <button
            v-for="t in theme.themes"
            :key="t.id"
            type="button"
            class="swatch"
            :class="{ on: theme.id === t.id }"
            :style="{
              background: t.vars['--bg'],
              color: t.vars['--text'],
              borderColor: theme.id === t.id ? t.vars['--accent'] : t.vars['--border-strong'],
            }"
            @click="theme.set(t.id)"
          >
            <span class="sdot" :style="{ background: t.vars['--accent'] }" />
            {{ t.label }}
          </button>
        </div>
      </div>

      <BaseField
        v-slot="{ id, describedby, invalid }"
        id="settings-default-cwd"
        label="Default working directory"
        hint="for new terminals"
        :error="defaultCwdError || undefined"
      >
        <span class="cwd-row">
          <input
            :id="id"
            v-model="form.defaultCwd"
            spellcheck="false"
            placeholder="C:\path"
            :aria-invalid="invalid || undefined"
            :aria-describedby="describedby"
            @input="onCwdInput"
            @blur="checkCwd"
          />
          <button type="button" class="browse" title="Browse folders" aria-label="Browse folders" @click="showPicker = true">📁</button>
          <span class="flag" :class="cwdState">
            {{ cwdState === 'ok' ? '✓' : cwdState === 'bad' ? '✗' : cwdState === 'checking' ? '…' : '' }}
          </span>
        </span>
      </BaseField>

      <label class="field">
        <span>Default shell</span>
        <select v-model="form.shellKind" @change="clearServerError('shellPath')">
          <option v-for="o in SHELLS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </label>
      <BaseField
        v-if="form.shellKind === 'custom'"
        v-slot="{ id, describedby, invalid }"
        id="settings-shell-path"
        label="Default shell path"
        :error="shellPathError || undefined"
      >
        <input
          :id="id"
          v-model="form.shellPath"
          spellcheck="false"
          placeholder="C:\path\to\shell.exe"
          :aria-invalid="invalid || undefined"
          :aria-describedby="describedby"
          @input="clearServerError('shellPath')"
        />
      </BaseField>

      <div class="group">
        <span class="group-title">Command routing</span>
        <label class="check">
          <input v-model="form.appendNewlineByDefault" type="checkbox" />
          <span>Append a newline so sent commands run immediately</span>
        </label>
        <label class="check">
          <input v-model="form.startTerminalOnSend" type="checkbox" />
          <span>Start a stopped terminal when a command is sent to it</span>
        </label>
      </div>

      <div class="group">
        <span class="group-title">Security</span>
        <label class="field" style="margin: 10px 0 0">
          <span>API auth token <i>(only if the backend sets KAPLAN_AUTH_TOKEN)</i></span>
          <input
            v-model="form.authToken"
            type="password"
            spellcheck="false"
            autocomplete="off"
            placeholder="leave empty for local (no auth)"
          />
        </label>
      </div>

      <p v-if="error" class="err">{{ error }}</p>

      <template #footer>
        <BaseButton variant="ghost" @click="emit('close')">Cancel</BaseButton>
        <BaseButton variant="primary" :loading="saving" :disabled="!canSave" @click="save">Save</BaseButton>
      </template>
  </BaseModal>

  <FolderPicker v-if="showPicker" :initial="form.defaultCwd" @select="onPickFolder" @close="showPicker = false" />
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
.field select {
  width: 100%;
}
.themes {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}
.swatch {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.swatch.on {
  border-width: 2px;
}
.sdot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex: none;
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
.group {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  margin: 6px 0 4px;
}
.group-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--text-faint);
}
.check {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 10px;
  font-size: 13px;
  color: var(--text-dim);
}
.check input {
  accent-color: var(--accent);
  flex: none;
}
.err {
  color: var(--red);
  font-size: 13px;
}
</style>
