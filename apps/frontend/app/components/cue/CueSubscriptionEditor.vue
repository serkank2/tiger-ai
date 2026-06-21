<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import BaseModal from '~/components/BaseModal.vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import type { CueEventType, CueSubscriptionInput } from '~/types';

const props = defineProps<{
  open: boolean;
  /** When set, the form edits this existing subscription; otherwise it creates a new one. */
  initial?: CueSubscriptionInput | null;
  saving?: boolean;
  error?: string | null;
}>();

const emit = defineEmits<{ close: []; save: [sub: CueSubscriptionInput, originalId: string | null] }>();

const EVENTS: { value: CueEventType; label: string; hint: string }[] = [
  { value: 'file.changed', label: 'File changed', hint: 'Fire when a file under the watched directory changes.' },
  { value: 'time.scheduled', label: 'Scheduled (interval)', hint: 'Fire repeatedly on an interval.' },
  { value: 'time.once', label: 'Once (at a time)', hint: 'Fire one time at a specific timestamp.' },
  { value: 'agent.completed', label: 'Agent completed', hint: 'Fire when a team/Tiger agent finishes.' },
  { value: 'cli.trigger', label: 'Manual trigger', hint: 'Only fires when you press Trigger.' },
];

// Flat editable form state. Numeric/interval fields are kept as strings for clean inputs and
// coerced on submit.
const form = reactive({
  id: '',
  name: '',
  enabled: true,
  event: 'file.changed' as CueEventType,
  promptSource: 'inline' as 'inline' | 'file',
  prompt: '',
  promptFile: '',
  watch: '',
  intervalSpec: '', // e.g. "30s", "5m", "1h" — converted to intervalMs
  at: '', // datetime-local value
  filterChangeType: 'any' as 'any' | 'created' | 'modified' | 'deleted',
  filterPathIncludes: '',
  filterTriggeredBy: 'any' as 'any' | 'team' | 'tiger',
  filterAllOf: '',
  targetKind: 'queue' as 'queue' | 'team',
  provider: '' as '' | 'claude' | 'codex' | 'antigravity' | 'mixed',
  priority: '',
  maxAttempts: '',
  workspacePath: '',
  projectName: '',
});

const localError = ref<string | null>(null);
const isEdit = computed(() => !!props.initial);
// Kept as a plain string (not template literals) so the double-brace var names are NOT parsed as
// Vue interpolation — a data value is rendered verbatim, never re-interpolated.
const promptVarsHint = 'Template vars: {{CUE_FILE_PATH}}, {{CUE_SOURCE}}, {{CUE_SOURCE_OUTPUT}}, {{CUE_EVENT}}.';
const promptPlaceholder = 'Run the test suite. The file {{CUE_FILE_PATH}} changed.';
const eventHint = computed(() => EVENTS.find((e) => e.value === form.event)?.hint ?? '');

/** Parse a "30s"/"5m"/"1h"/"500ms" spec (or a raw ms number) into milliseconds, or null. */
function specToMs(spec: string): number | null {
  const s = spec.trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d+)\s*(ms|s|m|h)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? 'ms';
  const mult = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1;
  return n * mult;
}

function msToSpec(ms?: number): string {
  if (!ms || ms <= 0) return '';
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/** ISO <-> datetime-local helpers (the input has no timezone; treat as local). */
function isoToLocalInput(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function resetFrom(initial?: CueSubscriptionInput | null): void {
  localError.value = null;
  if (!initial) {
    Object.assign(form, {
      id: '', name: '', enabled: true, event: 'file.changed', promptSource: 'inline', prompt: '',
      promptFile: '', watch: '', intervalSpec: '', at: '', filterChangeType: 'any', filterPathIncludes: '',
      filterTriggeredBy: 'any', filterAllOf: '', targetKind: 'queue', provider: '', priority: '',
      maxAttempts: '', workspacePath: '', projectName: '',
    });
    return;
  }
  Object.assign(form, {
    id: initial.id,
    name: initial.name ?? '',
    enabled: initial.enabled !== false,
    event: initial.event,
    promptSource: initial.promptFile ? 'file' : 'inline',
    prompt: initial.prompt ?? '',
    promptFile: initial.promptFile ?? '',
    watch: initial.watch ?? '',
    intervalSpec: msToSpec(initial.intervalMs),
    at: isoToLocalInput(initial.at),
    filterChangeType: initial.filter?.changeType ?? 'any',
    filterPathIncludes: initial.filter?.pathIncludes ?? '',
    filterTriggeredBy: initial.filter?.triggeredBy ?? 'any',
    filterAllOf: (initial.filter?.allOf ?? []).join(', '),
    targetKind: initial.target?.kind ?? 'queue',
    provider: initial.target?.provider ?? '',
    priority: initial.target?.priority != null ? String(initial.target.priority) : '',
    maxAttempts: initial.target?.maxAttempts != null ? String(initial.target.maxAttempts) : '',
    workspacePath: initial.target?.workspacePath ?? '',
    projectName: initial.target?.projectName ?? '',
  });
}

watch(
  () => [props.open, props.initial] as const,
  ([open]) => {
    if (open) resetFrom(props.initial);
  },
  { immediate: true },
);

function build(): CueSubscriptionInput | null {
  localError.value = null;
  const id = form.id.trim();
  if (!id) { localError.value = 'An id is required.'; return null; }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
    localError.value = 'id may only contain letters, numbers, "-" and "_".';
    return null;
  }
  const prompt = form.prompt.trim();
  const promptFile = form.promptFile.trim();
  if (form.promptSource === 'inline' && !prompt) { localError.value = 'A prompt is required.'; return null; }
  if (form.promptSource === 'file' && !promptFile) { localError.value = 'A prompt file path is required.'; return null; }

  const sub: CueSubscriptionInput = {
    id,
    event: form.event,
    enabled: form.enabled,
    target: { kind: form.targetKind },
  };
  if (form.name.trim()) sub.name = form.name.trim();
  if (form.promptSource === 'inline') sub.prompt = prompt;
  else sub.promptFile = promptFile;

  // Event-specific fields.
  if (form.event === 'file.changed' && form.watch.trim()) sub.watch = form.watch.trim();
  if (form.event === 'time.scheduled') {
    const ms = specToMs(form.intervalSpec);
    if (ms == null) { localError.value = 'Enter a valid interval like 30s, 5m, or 1h.'; return null; }
    sub.intervalMs = ms;
  }
  if (form.event === 'time.once') {
    if (!form.at) { localError.value = 'Pick a date/time for the one-shot.'; return null; }
    const d = new Date(form.at);
    if (Number.isNaN(d.getTime())) { localError.value = 'Invalid date/time.'; return null; }
    sub.at = d.toISOString();
  }

  // Filter (per event).
  const filter: NonNullable<CueSubscriptionInput['filter']> = {};
  if (form.event === 'file.changed') {
    if (form.filterChangeType !== 'any') filter.changeType = form.filterChangeType;
    if (form.filterPathIncludes.trim()) filter.pathIncludes = form.filterPathIncludes.trim();
  }
  if (form.event === 'agent.completed') {
    if (form.filterTriggeredBy !== 'any') filter.triggeredBy = form.filterTriggeredBy;
    const allOf = form.filterAllOf.split(',').map((s) => s.trim()).filter(Boolean);
    if (allOf.length) filter.allOf = allOf;
  }
  if (Object.keys(filter).length) sub.filter = filter;

  // Target details.
  if (form.targetKind === 'queue') {
    if (form.provider) sub.target.provider = form.provider;
    if (form.priority.trim()) sub.target.priority = Number(form.priority);
    if (form.maxAttempts.trim()) sub.target.maxAttempts = Number(form.maxAttempts);
    if (form.workspacePath.trim()) sub.target.workspacePath = form.workspacePath.trim();
    if (form.projectName.trim()) sub.target.projectName = form.projectName.trim();
  }
  return sub;
}

function onSubmit(): void {
  const sub = build();
  if (!sub) return;
  emit('save', sub, props.initial?.id ?? null);
}
</script>

<template>
  <BaseModal :open="open" :title="isEdit ? 'Edit subscription' : 'New subscription'" dismissible panel-class="cue-editor" @close="emit('close')">
    <form class="form" @submit.prevent="onSubmit">
      <div class="row two">
        <label class="field">
          <span>ID <em>*</em></span>
          <input v-model="form.id" :disabled="saving" placeholder="run-tests-on-change" autocomplete="off" />
        </label>
        <label class="field">
          <span>Name</span>
          <input v-model="form.name" :disabled="saving" placeholder="Run tests on change" autocomplete="off" />
        </label>
      </div>

      <label class="field">
        <span>Event</span>
        <select v-model="form.event" :disabled="saving">
          <option v-for="e in EVENTS" :key="e.value" :value="e.value">{{ e.label }}</option>
        </select>
        <small class="hint">{{ eventHint }}</small>
      </label>

      <!-- file.changed -->
      <template v-if="form.event === 'file.changed'">
        <div class="row two">
          <label class="field">
            <span>Watch directory</span>
            <input v-model="form.watch" :disabled="saving" placeholder="src (relative to workspace, default .)" autocomplete="off" />
          </label>
          <label class="field">
            <span>Change type</span>
            <select v-model="form.filterChangeType" :disabled="saving">
              <option value="any">Any</option>
              <option value="created">Created</option>
              <option value="modified">Modified</option>
              <option value="deleted">Deleted</option>
            </select>
          </label>
        </div>
        <label class="field">
          <span>Path includes (filter)</span>
          <input v-model="form.filterPathIncludes" :disabled="saving" placeholder=".ts (only fire when the path contains this)" autocomplete="off" />
        </label>
      </template>

      <!-- time.scheduled -->
      <label v-else-if="form.event === 'time.scheduled'" class="field">
        <span>Interval</span>
        <input v-model="form.intervalSpec" :disabled="saving" placeholder="30s, 5m, or 1h" autocomplete="off" />
        <small class="hint">How often to fire. Use s / m / h.</small>
      </label>

      <!-- time.once -->
      <label v-else-if="form.event === 'time.once'" class="field">
        <span>Fire at</span>
        <input v-model="form.at" type="datetime-local" :disabled="saving" />
      </label>

      <!-- agent.completed -->
      <template v-else-if="form.event === 'agent.completed'">
        <div class="row two">
          <label class="field">
            <span>Triggered by</span>
            <select v-model="form.filterTriggeredBy" :disabled="saving">
              <option value="any">Any</option>
              <option value="team">Team</option>
              <option value="tiger">Tiger</option>
            </select>
          </label>
          <label class="field">
            <span>Wait for all of (fan-in)</span>
            <input v-model="form.filterAllOf" :disabled="saving" placeholder="runId-a, stage-b (comma-separated)" autocomplete="off" />
          </label>
        </div>
      </template>

      <!-- Prompt source -->
      <div class="field">
        <span>Prompt</span>
        <div class="seg">
          <label class="seg-opt"><input v-model="form.promptSource" type="radio" value="inline" :disabled="saving" /> Inline</label>
          <label class="seg-opt"><input v-model="form.promptSource" type="radio" value="file" :disabled="saving" /> From file</label>
        </div>
        <textarea
          v-if="form.promptSource === 'inline'"
          v-model="form.prompt"
          :disabled="saving"
          rows="4"
          :placeholder="promptPlaceholder"
        />
        <input
          v-else
          v-model="form.promptFile"
          :disabled="saving"
          placeholder="prompts/run-tests.md (relative to workspace)"
          autocomplete="off"
        />
        <small class="hint">{{ promptVarsHint }}</small>
      </div>

      <!-- Target -->
      <label class="field">
        <span>Target</span>
        <select v-model="form.targetKind" :disabled="saving">
          <option value="queue">Queue a job</option>
          <option value="team">Steer the running team</option>
        </select>
      </label>

      <template v-if="form.targetKind === 'queue'">
        <div class="row two">
          <label class="field">
            <span>Provider</span>
            <select v-model="form.provider" :disabled="saving">
              <option value="">Default</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="antigravity">Antigravity</option>
              <option value="mixed">Mixed</option>
            </select>
          </label>
          <label class="field">
            <span>Priority</span>
            <input v-model="form.priority" :disabled="saving" type="number" inputmode="numeric" placeholder="0" />
          </label>
        </div>
        <div class="row two">
          <label class="field">
            <span>Max attempts</span>
            <input v-model="form.maxAttempts" :disabled="saving" type="number" inputmode="numeric" placeholder="1" />
          </label>
          <label class="field">
            <span>Project name</span>
            <input v-model="form.projectName" :disabled="saving" placeholder="(optional)" autocomplete="off" />
          </label>
        </div>
        <label class="field">
          <span>Workspace path</span>
          <input v-model="form.workspacePath" :disabled="saving" placeholder="(optional — defaults to the active workspace)" autocomplete="off" />
        </label>
      </template>

      <label class="check">
        <input v-model="form.enabled" type="checkbox" :disabled="saving" />
        <span>Enabled</span>
      </label>

      <p v-if="localError || error" class="err" role="alert">⚠ {{ localError || error }}</p>

      <div class="actions">
        <BaseButton type="button" variant="ghost" :disabled="saving" @click="emit('close')">Cancel</BaseButton>
        <BaseButton type="submit" :loading="saving">{{ isEdit ? 'Save changes' : 'Create' }}</BaseButton>
      </div>
    </form>
  </BaseModal>
</template>

<style scoped>
.form {
  display: grid;
  gap: 12px;
  width: min(620px, 92vw);
  max-height: 78vh;
  overflow-y: auto;
  padding: 2px;
}
.row.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.field {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.field > span {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
}
.field em {
  color: var(--red);
  font-style: normal;
}
input,
select,
textarea {
  width: 100%;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text);
  font: inherit;
}
textarea {
  resize: vertical;
  font-family: var(--font-mono);
  font-size: 13px;
}
.hint {
  color: var(--text-faint);
  font-size: 11px;
}
.seg {
  display: flex;
  gap: 14px;
  margin-bottom: 2px;
}
.seg-opt {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-dim);
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-dim);
}
.check input {
  width: auto;
}
.err {
  margin: 0;
  color: var(--red);
  font-size: 12px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 4px;
}
@media (max-width: 520px) {
  .row.two {
    grid-template-columns: 1fr;
  }
}
</style>
