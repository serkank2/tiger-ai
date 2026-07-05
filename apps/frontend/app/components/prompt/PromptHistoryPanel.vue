<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import EmptyState from '~/components/ui/EmptyState.vue';
import Skeleton from '~/components/ui/Skeleton.vue';
import Spinner from '~/components/ui/Spinner.vue';
import { useT } from '~/composables/useT';
import type { PromptHistoryEvent } from '~/types';

const { t } = useT();

const props = defineProps<{
  items: PromptHistoryEvent[];
  selectedId: string | null;
  loading?: boolean;
  refreshing?: boolean;
  error?: string | null;
}>();

const emit = defineEmits<{
  refresh: [];
  select: [item: PromptHistoryEvent];
}>();

const q = ref('');
const kind = ref('');
const project = ref('');
const status = ref('');
const dateFrom = ref('');
const dateTo = ref('');

const kinds = computed(() => unique(props.items.map((item) => item.kind).filter(Boolean)));
const projects = computed(() => unique(props.items.map((item) => item.projectId).filter(Boolean) as string[]));
const statuses = computed(() => unique(props.items.map(statusOf).filter(Boolean)));

const filtered = computed(() => {
  const text = q.value.trim().toLowerCase();
  const from = dateFrom.value ? new Date(`${dateFrom.value}T00:00:00`).getTime() : null;
  const to = dateTo.value ? new Date(`${dateTo.value}T23:59:59`).getTime() : null;
  return props.items.filter((item) => {
    if (kind.value && item.kind !== kind.value) return false;
    if (project.value && item.projectId !== project.value) return false;
    if (status.value && statusOf(item) !== status.value) return false;
    const created = new Date(item.createdAt).getTime();
    if (from !== null && created < from) return false;
    if (to !== null && created > to) return false;
    if (!text) return true;
    return searchableText(item).includes(text);
  });
});

const selected = computed(
  () => filtered.value.find((item) => item.id === props.selectedId) ?? filtered.value[0] ?? null,
);

watch(
  filtered,
  (items) => {
    if (items.length && (!props.selectedId || !items.some((item) => item.id === props.selectedId))) {
      emit('select', items[0]!);
    }
  },
  { immediate: true },
);

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function statusOf(item: PromptHistoryEvent): string {
  if (item.status) return item.status;
  const metadataStatus = item.metadata?.status;
  if (typeof metadataStatus === 'string') return metadataStatus;
  if (item.error) return 'failed';
  if (item.outputText) return 'done';
  return 'saved';
}

function displayText(item: PromptHistoryEvent): string {
  return item.outputText || item.inputText || '';
}

function searchableText(item: PromptHistoryEvent): string {
  return [item.id, item.kind, item.projectId, item.generationId, item.inputText, item.outputText, statusOf(item)]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

function fmtDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
</script>

<template>
  <section class="history-panel">
    <div class="filters" :aria-label="t('prompts.history.filtersAria')">
      <input v-model="q" :placeholder="t('prompts.history.searchPlaceholder')" spellcheck="false" />
      <select v-model="kind">
        <option value="">{{ t('prompts.history.allKinds') }}</option>
        <option v-for="value in kinds" :key="value" :value="value">{{ value.replaceAll('_', ' ') }}</option>
      </select>
      <select v-model="project">
        <option value="">{{ t('prompts.history.allProjects') }}</option>
        <option v-for="value in projects" :key="value" :value="value">{{ value }}</option>
      </select>
      <select v-model="status">
        <option value="">{{ t('prompts.history.allStatuses') }}</option>
        <option v-for="value in statuses" :key="value" :value="value">{{ value }}</option>
      </select>
      <input v-model="dateFrom" type="date" :aria-label="t('prompts.history.fromDate')" />
      <input v-model="dateTo" type="date" :aria-label="t('prompts.history.toDate')" />
      <button class="refresh" :disabled="loading || refreshing" @click="emit('refresh')">
        {{ refreshing ? t('prompts.history.updating') : t('prompts.history.refresh') }}
      </button>
    </div>

    <div v-if="loading && !items.length" class="state">
      <Spinner :label="t('prompts.history.loading')" />
      <Skeleton :lines="5" />
    </div>

    <EmptyState v-else-if="error" :title="t('prompts.history.unavailableTitle')" :description="error" tone="danger">
      <template #actions>
        <button class="refresh" @click="emit('refresh')">{{ t('prompts.history.retry') }}</button>
      </template>
    </EmptyState>

    <EmptyState
      v-else-if="!items.length"
      :title="t('prompts.history.emptyTitle')"
      :description="t('prompts.history.emptyDescription')"
    />

    <EmptyState
      v-else-if="!filtered.length"
      :title="t('prompts.history.noMatchesTitle')"
      :description="t('prompts.history.noMatchesDescription')"
    />

    <div v-else class="history-grid">
      <div class="list" :aria-label="t('prompts.history.resultsAria')">
        <button
          v-for="item in filtered"
          :key="item.id"
          type="button"
          class="row"
          :class="{ active: item.id === selected?.id }"
          @click="emit('select', item)"
        >
          <span class="row-main">
            <b>{{ displayText(item).slice(0, 90) || item.kind }}</b>
            <small>{{ item.kind.replaceAll('_', ' ') }} / {{ statusOf(item) }} / {{ fmtDate(item.createdAt) }}</small>
          </span>
          <span v-if="item.projectId" class="project" :title="item.projectId">{{ item.projectId }}</span>
        </button>
      </div>

      <article class="compare" :aria-label="t('prompts.history.compareAria')">
        <template v-if="selected">
          <header>
            <div>
              <h3>{{ selected.kind.replaceAll('_', ' ') }}</h3>
              <p>{{ fmtDate(selected.createdAt) }}</p>
            </div>
            <span class="status">{{ statusOf(selected) }}</span>
          </header>
          <div class="compare-cols">
            <section>
              <h4>{{ t('prompts.history.original') }}</h4>
              <pre>{{ selected.inputText || t('prompts.history.noOriginalStored') }}</pre>
            </section>
            <section>
              <h4>{{ t('prompts.history.reusablePrompt') }}</h4>
              <pre>{{ selected.outputText || selected.inputText || t('prompts.history.noPromptStored') }}</pre>
            </section>
          </div>
        </template>
      </article>
    </div>
  </section>
</template>

<style scoped>
.history-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  height: 100%;
}
.filters {
  display: grid;
  grid-template-columns: minmax(220px, 1.5fr) repeat(5, minmax(120px, 1fr)) auto;
  gap: 8px;
  align-items: center;
}
.refresh {
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
  padding: 8px 12px;
  font-weight: 600;
}
.refresh:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.state {
  display: grid;
  gap: 14px;
  padding: 20px;
}
.history-grid {
  display: grid;
  grid-template-columns: minmax(280px, 380px) minmax(0, 1fr);
  gap: 14px;
  min-height: 0;
  flex: 1;
}
.list {
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
}
.row {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 0;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  text-align: left;
}
.row:hover,
.row.active {
  background: var(--accent-soft);
}
.row.active {
  box-shadow: inset 3px 0 0 var(--accent);
}
.row-main {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 4px;
}
.row-main b {
  font-size: 13px;
  line-height: 1.35;
  color: var(--text);
}
.row-main small,
.project {
  font-size: 11px;
  color: var(--text-faint);
}
.project {
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}
.compare {
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
  padding: 14px;
  display: flex;
  flex-direction: column;
}
.compare header {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 12px;
}
.compare h3,
.compare p,
.compare h4 {
  margin: 0;
}
.compare h3 {
  font-size: 15px;
}
.compare p {
  font-size: 12px;
  color: var(--text-dim);
}
.status {
  margin-left: auto;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  padding: 2px 8px;
  font-size: 11px;
  color: var(--text-dim);
}
.compare-cols {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  min-height: 0;
  flex: 1;
}
.compare-cols section {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.compare h4 {
  font-size: 12px;
  color: var(--text-dim);
  text-transform: uppercase;
}
pre {
  flex: 1;
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
  padding: 10px;
}

@media (max-width: 1100px) {
  .filters,
  .history-grid,
  .compare-cols {
    grid-template-columns: 1fr;
  }
}
</style>
