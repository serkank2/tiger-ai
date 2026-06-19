<script setup lang="ts">
import { computed, ref } from 'vue';
import EmptyState from '~/components/ui/EmptyState.vue';
import Spinner from '~/components/ui/Spinner.vue';
import type { PromptGenerationState, TigerAgentType } from '~/types';

const props = defineProps<{
  state: PromptGenerationState | null;
  starting?: boolean;
  loading?: boolean;
  error?: string | null;
}>();

const emit = defineEmits<{
  submit: [input: { inputText: string; agentType: TigerAgentType; model?: string; effort?: string }];
  selectResult: [];
}>();

const rough = ref('');
const agentType = ref<TigerAgentType>('claude');
const model = ref('');
const effort = ref('');

const generation = computed(() => props.state?.generation ?? null);
const output = computed(() => generation.value?.outputText?.trim() ?? '');
const statusLabel = computed(() => {
  const status = generation.value?.status;
  if (!status) return 'idle';
  if (status === 'pending') return 'queued';
  if (props.state?.progress === 'persisting') return 'saving result';
  return status;
});
const isBusy = computed(() => props.starting || generation.value?.status === 'pending' || generation.value?.status === 'running');
const canSubmit = computed(() => rough.value.trim().length > 0 && !props.starting);

function submit(): void {
  const inputText = rough.value.trim();
  if (!inputText || props.starting) return;
  emit('submit', {
    inputText,
    agentType: agentType.value,
    model: model.value.trim() || undefined,
    effort: effort.value.trim() || undefined,
  });
}
</script>

<template>
  <section class="generation-panel">
    <form class="draft" @submit.prevent="submit">
      <div class="draft-head">
        <h3>Generate Improved Prompt</h3>
        <span class="status" :class="`st-${generation?.status ?? 'idle'}`">{{ statusLabel }}</span>
      </div>
      <textarea
        v-model="rough"
        rows="9"
        maxlength="100000"
        placeholder="Paste a rough draft. The generator will turn it into a complete prompt."
        spellcheck="false"
      />
      <div class="controls">
        <select v-model="agentType" aria-label="Generation agent">
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="antigravity">Antigravity</option>
        </select>
        <input v-model="model" placeholder="Model override" spellcheck="false" />
        <input v-model="effort" placeholder="Effort override" spellcheck="false" />
        <button class="primary" type="submit" :disabled="!canSubmit">
          {{ starting ? 'Submitting' : 'Generate' }}
        </button>
      </div>
      <p class="count">{{ rough.length.toLocaleString() }}/100,000</p>
    </form>

    <article class="result">
      <div v-if="loading" class="state">
        <Spinner label="Loading generation" />
      </div>

      <EmptyState
        v-else-if="error && !generation"
        title="Generation unavailable"
        :description="error"
        tone="danger"
      />

      <EmptyState
        v-else-if="!generation"
        title="No generation running"
        description="Submit a rough draft to queue a prompt-generation run."
      />

      <div v-else class="result-body">
        <header>
          <div>
            <h3>Generation Result</h3>
            <p>{{ generation.agentType }} / {{ generation.model || 'default model' }}</p>
          </div>
          <span class="status" :class="`st-${generation.status}`">{{ statusLabel }}</span>
        </header>

        <div v-if="isBusy" class="state inline">
          <Spinner :label="generation.status === 'pending' ? 'Queued for generation' : 'Generation running'" />
          <p v-if="state?.progress && state.progress !== 'idle'">Progress: {{ String(state.progress).replaceAll('_', ' ') }}</p>
        </div>

        <div v-else-if="generation.status === 'failed'" class="failed">
          <b>Generation failed</b>
          <p>{{ generation.error || error || 'The generation run did not produce a prompt.' }}</p>
        </div>

        <template v-else-if="output">
          <pre>{{ output }}</pre>
          <div class="result-actions">
            <button class="secondary" @click="emit('selectResult')">Use This Result</button>
          </div>
        </template>

        <EmptyState
          v-else
          title="No improved prompt yet"
          description="The run completed without a reusable output."
          tone="danger"
        />
      </div>
    </article>
  </section>
</template>

<style scoped>
.generation-panel {
  display: grid;
  grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
  gap: 14px;
  min-height: 0;
  height: 100%;
}
.draft,
.result {
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
  padding: 14px;
}
.draft {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.draft-head,
.result header {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
h3,
p {
  margin: 0;
}
h3 {
  font-size: 15px;
}
p,
.count {
  color: var(--text-dim);
  font-size: 12px;
}
textarea {
  flex: 1;
  min-height: 220px;
  resize: none;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 10px;
}
.controls {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 8px;
}
.primary,
.secondary {
  border: 1px solid var(--accent);
  font-weight: 700;
  padding: 8px 14px;
}
.primary {
  background: var(--accent);
  color: var(--bg);
}
.secondary {
  color: var(--accent);
}
.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.result {
  display: flex;
  flex-direction: column;
}
.result-body {
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.status {
  margin-left: auto;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  padding: 2px 8px;
  color: var(--text-dim);
  font-size: 11px;
}
.status.st-running,
.status.st-pending {
  border-color: var(--accent);
  color: var(--accent);
}
.status.st-done {
  border-color: var(--green);
  color: var(--green);
}
.status.st-failed {
  border-color: var(--red);
  color: var(--red);
}
.state {
  display: grid;
  place-items: center;
  gap: 10px;
  flex: 1;
  min-height: 180px;
}
.state.inline {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
}
.failed {
  border: 1px solid var(--red);
  color: var(--text);
  border-radius: var(--radius-sm);
  background: rgba(229, 86, 75, 0.12);
  padding: 12px;
}
.failed p {
  margin-top: 6px;
  color: var(--text-dim);
}
pre {
  flex: 1;
  min-height: 0;
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px;
}
.result-actions {
  display: flex;
  justify-content: flex-end;
}

@media (max-width: 980px) {
  .generation-panel,
  .controls {
    grid-template-columns: 1fr;
  }
}
</style>
