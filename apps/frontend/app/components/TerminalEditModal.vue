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

const form = reactive({
  name: props.terminal?.name ?? '',
  groupId: props.terminal?.groupId ?? null,
  cwd: props.terminal?.cwd ?? settings.settings?.defaultCwd ?? '',
  initialCommand: props.terminal?.initialCommand ?? '',
  shellKind: (props.terminal?.shell.kind ?? 'system-default') as ShellKind,
  shellPath: props.terminal?.shell.path ?? '',
  shellArgs: (props.terminal?.shell.args ?? []).join(' '),
  autostart: props.terminal?.autostart ?? false,
});

const cwdState = ref<'idle' | 'checking' | 'ok' | 'bad'>('idle');
const saving = ref(false);
const error = ref('');

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
    autostart: form.autostart,
  };

  try {
    if (props.terminal) await terminals.update(props.terminal.id, body);
    else await terminals.create(body);
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
  <div class="backdrop" @click.self="emit('close')" @keydown.esc="emit('close')">
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
          <span class="flag" :class="cwdState">
            {{ cwdState === 'ok' ? '✓' : cwdState === 'bad' ? '✗' : cwdState === 'checking' ? '…' : '' }}
          </span>
        </span>
      </label>

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

      <label class="check">
        <input v-model="form.autostart" type="checkbox" />
        <span>Auto-start when Kaplan launches</span>
      </label>

      <p v-if="error" class="err">{{ error }}</p>

      <div class="foot">
        <button class="ghost" @click="emit('close')">Cancel</button>
        <button class="primary" :disabled="saving" @click="save">
          {{ saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create' }}
        </button>
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
  width: min(520px, 92vw);
  max-height: 90vh;
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
.field select {
  width: 100%;
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
