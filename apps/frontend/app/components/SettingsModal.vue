<script setup lang="ts">
import type { AppSettings, ShellKind } from '~/types';

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
});

const cwdState = ref<'idle' | 'checking' | 'ok' | 'bad'>('idle');
const saving = ref(false);
const error = ref('');

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
  if (form.shellKind === 'custom' && !form.shellPath.trim()) {
    error.value = 'A custom default shell needs a path.';
    return;
  }
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
    const err = e as { data?: { error?: { message?: string } }; message?: string };
    error.value = err?.data?.error?.message ?? err?.message ?? 'Save failed.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true">
      <h2>Settings</h2>

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

      <label class="field">
        <span>Default working directory <i>(for new terminals)</i></span>
        <span class="cwd-row">
          <input v-model="form.defaultCwd" spellcheck="false" placeholder="C:\path" @blur="checkCwd" />
          <span class="flag" :class="cwdState">
            {{ cwdState === 'ok' ? '✓' : cwdState === 'bad' ? '✗' : cwdState === 'checking' ? '…' : '' }}
          </span>
        </span>
      </label>

      <label class="field">
        <span>Default shell</span>
        <select v-model="form.shellKind">
          <option v-for="o in SHELLS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </label>
      <label v-if="form.shellKind === 'custom'" class="field">
        <span>Default shell path</span>
        <input v-model="form.shellPath" spellcheck="false" placeholder="C:\path\to\shell.exe" />
      </label>

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

      <p v-if="error" class="err">{{ error }}</p>

      <div class="foot">
        <button class="ghost" @click="emit('close')">Cancel</button>
        <button class="primary" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save' }}</button>
      </div>
    </div>
  </div>
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
  width: min(500px, 92vw);
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
.primary {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #1b1206;
  font-weight: 700;
  padding: 8px 18px;
}
.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
