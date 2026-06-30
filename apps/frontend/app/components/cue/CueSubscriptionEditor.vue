<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import BaseModal from '~/components/ui/BaseModal.vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import { useT } from '~/composables/useT';
import type { CueEventType, CueSubscriptionInput } from '~/types';

const props = defineProps<{
  open: boolean;
  /** When set, the form edits this existing subscription; otherwise it creates a new one. */
  initial?: CueSubscriptionInput | null;
  saving?: boolean;
  error?: string | null;
}>();

const emit = defineEmits<{ close: []; save: [sub: CueSubscriptionInput, originalId: string | null] }>();

const { t } = useT();
const EVENTS = computed<{ value: CueEventType; label: string; hint: string }[]>(() => [
  { value: 'file.changed', label: t('cue.editor.events.fileChanged'), hint: t('cue.editor.eventHints.fileChanged') },
  { value: 'time.scheduled', label: t('cue.editor.events.scheduled'), hint: t('cue.editor.eventHints.scheduled') },
  { value: 'time.once', label: t('cue.editor.events.once'), hint: t('cue.editor.eventHints.once') },
  {
    value: 'agent.completed',
    label: t('cue.editor.events.agentCompleted'),
    hint: t('cue.editor.eventHints.agentCompleted'),
  },
  { value: 'cli.trigger', label: t('cue.editor.events.manual'), hint: t('cue.editor.eventHints.manual') },
]);

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
  intervalSpec: '', // e.g. "30s", "5m", "1h" - converted to intervalMs
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
const promptVarsHint = computed(() => t('cue.editor.promptVarsHint'));
const promptPlaceholder = computed(() => t('cue.editor.placeholders.prompt'));
const eventHint = computed(() => EVENTS.value.find((e) => e.value === form.event)?.hint ?? '');

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
      id: '',
      name: '',
      enabled: true,
      event: 'file.changed',
      promptSource: 'inline',
      prompt: '',
      promptFile: '',
      watch: '',
      intervalSpec: '',
      at: '',
      filterChangeType: 'any',
      filterPathIncludes: '',
      filterTriggeredBy: 'any',
      filterAllOf: '',
      targetKind: 'queue',
      provider: '',
      priority: '',
      maxAttempts: '',
      workspacePath: '',
      projectName: '',
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
  if (!id) {
    localError.value = t('cue.editor.validation.idRequired');
    return null;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
    localError.value = t('cue.editor.validation.idFormat');
    return null;
  }
  const prompt = form.prompt.trim();
  const promptFile = form.promptFile.trim();
  if (form.promptSource === 'inline' && !prompt) {
    localError.value = t('cue.editor.validation.promptRequired');
    return null;
  }
  if (form.promptSource === 'file' && !promptFile) {
    localError.value = t('cue.editor.validation.promptFileRequired');
    return null;
  }

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
    if (ms == null) {
      localError.value = t('cue.editor.validation.intervalFormat');
      return null;
    }
    sub.intervalMs = ms;
  }
  if (form.event === 'time.once') {
    if (!form.at) {
      localError.value = t('cue.editor.validation.dateRequired');
      return null;
    }
    const d = new Date(form.at);
    if (Number.isNaN(d.getTime())) {
      localError.value = t('cue.editor.validation.invalidDate');
      return null;
    }
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
    const allOf = form.filterAllOf
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
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
  <BaseModal
    v-if="open"
    :title="isEdit ? t('cue.editor.editTitle') : t('cue.editor.newTitle')"
    size="lg"
    @close="emit('close')"
  >
    <form class="form" @submit.prevent="onSubmit">
      <div class="row two">
        <label class="field">
          <span>{{ t('cue.editor.labels.id') }} <em>*</em></span>
          <input
            v-model="form.id"
            :disabled="saving"
            :placeholder="t('cue.editor.placeholders.id')"
            autocomplete="off"
          />
        </label>
        <label class="field">
          <span>{{ t('cue.editor.labels.name') }}</span>
          <input
            v-model="form.name"
            :disabled="saving"
            :placeholder="t('cue.editor.placeholders.name')"
            autocomplete="off"
          />
        </label>
      </div>

      <label class="field">
        <span>{{ t('cue.editor.labels.event') }}</span>
        <select v-model="form.event" :disabled="saving">
          <option v-for="e in EVENTS" :key="e.value" :value="e.value">{{ e.label }}</option>
        </select>
        <small class="hint">{{ eventHint }}</small>
      </label>

      <template v-if="form.event === 'file.changed'">
        <div class="row two">
          <label class="field">
            <span>{{ t('cue.editor.labels.watchDirectory') }}</span>
            <input
              v-model="form.watch"
              :disabled="saving"
              :placeholder="t('cue.editor.placeholders.watch')"
              autocomplete="off"
            />
          </label>
          <label class="field">
            <span>{{ t('cue.editor.labels.changeType') }}</span>
            <select v-model="form.filterChangeType" :disabled="saving">
              <option value="any">{{ t('cue.editor.changeTypes.any') }}</option>
              <option value="created">{{ t('cue.editor.changeTypes.created') }}</option>
              <option value="modified">{{ t('cue.editor.changeTypes.modified') }}</option>
              <option value="deleted">{{ t('cue.editor.changeTypes.deleted') }}</option>
            </select>
          </label>
        </div>
        <label class="field">
          <span>{{ t('cue.editor.labels.pathIncludes') }}</span>
          <input
            v-model="form.filterPathIncludes"
            :disabled="saving"
            :placeholder="t('cue.editor.placeholders.pathIncludes')"
            autocomplete="off"
          />
        </label>
      </template>

      <label v-else-if="form.event === 'time.scheduled'" class="field">
        <span>{{ t('cue.editor.labels.interval') }}</span>
        <input
          v-model="form.intervalSpec"
          :disabled="saving"
          :placeholder="t('cue.editor.placeholders.interval')"
          autocomplete="off"
        />
        <small class="hint">{{ t('cue.editor.intervalHint') }}</small>
      </label>

      <label v-else-if="form.event === 'time.once'" class="field">
        <span>{{ t('cue.editor.labels.fireAt') }}</span>
        <input v-model="form.at" type="datetime-local" :disabled="saving" />
      </label>

      <template v-else-if="form.event === 'agent.completed'">
        <div class="row two">
          <label class="field">
            <span>{{ t('cue.editor.labels.triggeredBy') }}</span>
            <select v-model="form.filterTriggeredBy" :disabled="saving">
              <option value="any">{{ t('cue.editor.triggeredBy.any') }}</option>
              <option value="team">{{ t('cue.editor.triggeredBy.team') }}</option>
              <option value="tiger">{{ t('cue.editor.triggeredBy.tiger') }}</option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('cue.editor.labels.waitForAll') }}</span>
            <input
              v-model="form.filterAllOf"
              :disabled="saving"
              :placeholder="t('cue.editor.placeholders.waitForAll')"
              autocomplete="off"
            />
          </label>
        </div>
      </template>

      <div class="field">
        <span>{{ t('cue.editor.labels.prompt') }}</span>
        <div class="seg">
          <label class="seg-opt"
            ><input v-model="form.promptSource" type="radio" value="inline" :disabled="saving" />
            {{ t('cue.editor.promptSources.inline') }}</label
          >
          <label class="seg-opt"
            ><input v-model="form.promptSource" type="radio" value="file" :disabled="saving" />
            {{ t('cue.editor.promptSources.file') }}</label
          >
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
          :placeholder="t('cue.editor.placeholders.promptFile')"
          autocomplete="off"
        />
        <small class="hint">{{ promptVarsHint }}</small>
      </div>

      <label class="field">
        <span>{{ t('cue.editor.labels.target') }}</span>
        <select v-model="form.targetKind" :disabled="saving">
          <option value="queue">{{ t('cue.editor.targets.queue') }}</option>
          <option value="team">{{ t('cue.editor.targets.team') }}</option>
        </select>
      </label>

      <template v-if="form.targetKind === 'queue'">
        <div class="row two">
          <label class="field">
            <span>{{ t('cue.editor.labels.provider') }}</span>
            <select v-model="form.provider" :disabled="saving">
              <option value="">{{ t('cue.editor.default') }}</option>
              <option value="claude">{{ t('common.providers.claude') }}</option>
              <option value="codex">{{ t('common.providers.codex') }}</option>
              <option value="antigravity">{{ t('common.providers.antigravity') }}</option>
              <option value="mixed">{{ t('common.providers.mixed') }}</option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('cue.editor.labels.priority') }}</span>
            <input v-model="form.priority" :disabled="saving" type="number" inputmode="numeric" placeholder="0" />
          </label>
        </div>
        <div class="row two">
          <label class="field">
            <span>{{ t('cue.editor.labels.maxAttempts') }}</span>
            <input v-model="form.maxAttempts" :disabled="saving" type="number" inputmode="numeric" placeholder="1" />
          </label>
          <label class="field">
            <span>{{ t('cue.editor.labels.projectName') }}</span>
            <input
              v-model="form.projectName"
              :disabled="saving"
              :placeholder="t('cue.editor.placeholders.optional')"
              autocomplete="off"
            />
          </label>
        </div>
        <label class="field">
          <span>{{ t('cue.editor.labels.workspacePath') }}</span>
          <input
            v-model="form.workspacePath"
            :disabled="saving"
            :placeholder="t('cue.editor.placeholders.workspacePath')"
            autocomplete="off"
          />
        </label>
      </template>

      <label class="check">
        <input v-model="form.enabled" type="checkbox" :disabled="saving" />
        <span>{{ t('cue.editor.labels.enabled') }}</span>
      </label>

      <p v-if="localError || error" class="err" role="alert">{{ localError || error }}</p>
    </form>

    <template #footer>
      <BaseButton type="button" variant="ghost" :disabled="saving" @click="emit('close')">{{
        t('common.cancel')
      }}</BaseButton>
      <BaseButton type="button" variant="primary" :loading="saving" @click="onSubmit">{{
        isEdit ? t('cue.editor.saveChanges') : t('common.create')
      }}</BaseButton>
    </template>
  </BaseModal>
</template>

<style scoped>
.form {
  display: grid;
  gap: 12px;
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
@media (max-width: 520px) {
  .row.two {
    grid-template-columns: 1fr;
  }
}
</style>
