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
});

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
          <button type="button" class="browse" title="Browse folders" @click="showPicker = true">📁</button>
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

      <label class="field">
        <span>Environment variables <i>(KEY=VALUE per line, optional)</i></span>
        <textarea v-model="form.env" rows="3" spellcheck="false" placeholder="NODE_ENV=development" />
      </label>

      <label class="check">
        <input v-model="form.autostart" type="checkbox" />
        <span>Auto-start when Kaplan launches</span>
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
.field select,
.field textarea {
  width: 100%;
}
.field textarea {
  font-family: var(--font-mono);
  font-size: 12px;
  resize: vertical;
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
