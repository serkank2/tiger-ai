<script setup lang="ts">
import type { AppSettings, ShellKind } from '~/types';
import BaseModal from '~/components/ui/BaseModal.vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import BaseField from '~/components/ui/BaseField.vue';
import BaseInput from '~/components/ui/BaseInput.vue';
import { errText } from '~/lib/apiError';
import { absoluteLocalPathError, customShellPathError, usesWindowsPathSyntax } from '~/lib/formValidation';
import type { LocaleCode } from '~/locales';

const emit = defineEmits<{ close: [] }>();
const settings = useSettingsStore();
const theme = useThemeStore();
const notices = useNoticesStore();
const api = useApi();
const { t } = useT();
const { locale, locales, setLocale } = useLocale();

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

function onLocaleChange(e: Event) {
  setLocale((e.target as HTMLSelectElement).value as LocaleCode);
}

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
    notices.push(t('settings.saved'));
    emit('close');
  } catch (e) {
    applyServerError(errText(e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <BaseModal :title="t('nav.settings')" size="md" @close="emit('close')">
    <!-- Appearance: theme + language. -->
    <section class="section">
      <header class="section-head">
        <h3 class="section-title">{{ t('settings.appearance') }}</h3>
        <p class="section-desc">{{ t('settings.appearanceDesc') }}</p>
      </header>

      <div class="field">
        <span class="field-label">{{ t('settings.theme') }}</span>
        <div class="themes">
          <button
            v-for="th in theme.themes"
            :key="th.id"
            type="button"
            class="swatch"
            :class="{ on: theme.id === th.id }"
            :style="{
              background: th.vars['--bg'],
              color: th.vars['--text'],
              borderColor: theme.id === th.id ? th.vars['--accent'] : th.vars['--border-strong'],
            }"
            @click="theme.set(th.id)"
          >
            <span class="sdot" :style="{ background: th.vars['--accent'] }" />
            {{ th.label }}
          </button>
        </div>
        <p class="field-hint">{{ t('settings.themeHint') }}</p>
      </div>

      <label class="field" for="settings-locale">
        <span class="field-label">{{ t('settings.language') }}</span>
        <select id="settings-locale" :value="locale" @change="onLocaleChange">
          <option v-for="l in locales" :key="l.code" :value="l.code">{{ l.label }}</option>
        </select>
        <span class="field-hint">{{ t('settings.languageHint') }}</span>
      </label>
    </section>

    <div class="divider" role="presentation" />

    <!-- Workspace: default cwd + shell. -->
    <section class="section">
      <header class="section-head">
        <h3 class="section-title">{{ t('settings.workspace') }}</h3>
        <p class="section-desc">{{ t('settings.workspaceDesc') }}</p>
      </header>

      <BaseField
        id="settings-default-cwd"
        v-slot="{ id, describedby, invalid }"
        :label="t('settings.defaultCwd')"
        :hint="t('settings.defaultCwdHint')"
        :error="defaultCwdError || undefined"
      >
        <span class="cwd-row">
          <BaseInput
            :id="id"
            v-model="form.defaultCwd"
            spellcheck="false"
            :placeholder="t('settings.defaultCwdPlaceholder')"
            :invalid="invalid || undefined"
            :describedby="describedby"
            @input="onCwdInput"
            @blur="checkCwd"
          />
          <BaseButton
            class="browse"
            icon-only
            :title="t('settings.browseFolders')"
            :aria-label="t('settings.browseFolders')"
            @click="showPicker = true"
          >
            📁
          </BaseButton>
          <span class="flag" :class="cwdState">
            {{ cwdState === 'ok' ? '✓' : cwdState === 'bad' ? '✗' : cwdState === 'checking' ? '…' : '' }}
          </span>
        </span>
      </BaseField>

      <label class="field">
        <span class="field-label">{{ t('settings.defaultShell') }}</span>
        <select v-model="form.shellKind" @change="clearServerError('shellPath')">
          <option v-for="o in SHELLS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </label>
      <BaseField
        v-if="form.shellKind === 'custom'"
        id="settings-shell-path"
        v-slot="{ id, describedby, invalid }"
        :label="t('settings.defaultShellPath')"
        :error="shellPathError || undefined"
      >
        <BaseInput
          :id="id"
          v-model="form.shellPath"
          spellcheck="false"
          :placeholder="t('settings.defaultShellPathPlaceholder')"
          :invalid="invalid || undefined"
          :describedby="describedby"
          @input="clearServerError('shellPath')"
        />
      </BaseField>
    </section>

    <div class="divider" role="presentation" />

    <!-- Command routing. -->
    <section class="section">
      <header class="section-head">
        <h3 class="section-title">{{ t('settings.commandRouting') }}</h3>
        <p class="section-desc">{{ t('settings.commandRoutingDesc') }}</p>
      </header>

      <label class="check">
        <input v-model="form.appendNewlineByDefault" type="checkbox" />
        <span>{{ t('settings.appendNewline') }}</span>
      </label>
      <label class="check">
        <input v-model="form.startTerminalOnSend" type="checkbox" />
        <span>{{ t('settings.startTerminalOnSend') }}</span>
      </label>
    </section>

    <div class="divider" role="presentation" />

    <!-- Security. -->
    <section class="section">
      <header class="section-head">
        <h3 class="section-title">{{ t('settings.security') }}</h3>
        <p class="section-desc">{{ t('settings.securityDesc') }}</p>
      </header>

      <label class="field" for="settings-auth-token">
        <span class="field-label">{{ t('settings.authToken') }}</span>
        <BaseInput
          id="settings-auth-token"
          v-model="form.authToken"
          type="password"
          spellcheck="false"
          autocomplete="off"
          :placeholder="t('settings.authTokenPlaceholder')"
        />
        <span class="field-hint">{{ t('settings.authTokenHint') }}</span>
      </label>
    </section>

    <p v-if="error" class="err">{{ error }}</p>

    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</BaseButton>
      <BaseButton variant="primary" :loading="saving" :disabled="!canSave" @click="save">{{ t('common.save') }}</BaseButton>
    </template>
  </BaseModal>

  <FolderPicker v-if="showPicker" :initial="form.defaultCwd" @select="onPickFolder" @close="showPicker = false" />
</template>

<style scoped>
.section {
  display: block;
}
.section-head {
  margin-bottom: var(--space-3, 12px);
}
.section-title {
  margin: 0;
  font-size: var(--text-xs, 11px);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--text-faint);
}
.section-desc {
  margin: var(--space-1, 4px) 0 0;
  font-size: var(--text-sm, 13px);
  line-height: var(--leading-snug, 1.35);
  color: var(--text-dim);
}
.divider {
  height: 1px;
  margin: var(--space-5, 20px) 0;
  background: var(--border);
}
.field {
  display: block;
  margin-bottom: var(--space-4, 16px);
}
.field:last-child {
  margin-bottom: 0;
}
.field-label {
  display: block;
  font-size: var(--text-xs, 12px);
  color: var(--text-dim);
  margin-bottom: var(--space-2, 8px);
}
.field-hint {
  display: block;
  margin: var(--space-2, 8px) 0 0;
  font-size: var(--text-xs, 12px);
  line-height: var(--leading-snug, 1.35);
  color: var(--text-faint);
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
.check {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 10px;
  font-size: 13px;
  color: var(--text-dim);
}
.check:first-of-type {
  margin-top: 0;
}
.check input {
  accent-color: var(--accent);
  flex: none;
}
.err {
  margin-top: var(--space-4, 16px);
  color: var(--red);
  font-size: 13px;
}
</style>
