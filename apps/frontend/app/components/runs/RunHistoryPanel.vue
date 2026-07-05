<script setup lang="ts">
// Past runs from the global index: status, outcome, cost — and read-only reopen.
import BaseButton from '~/components/ui/BaseButton.vue';
import { useT } from '~/composables/useT';
import type { RunIndexEntry } from '~/types';

defineProps<{ entries: RunIndexEntry[]; loading: boolean; busyId?: string | null }>();
const emit = defineEmits<{ open: [runId: string]; refresh: [] }>();
const { t } = useT();

function when(entry: RunIndexEntry): string {
  const iso = entry.endedAt ?? entry.startedAt ?? entry.createdAt;
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function cost(entry: RunIndexEntry): string {
  return entry.costUsd !== undefined && entry.costUsd > 0 ? `$${entry.costUsd.toFixed(4)}` : '—';
}
</script>

<template>
  <div class="card history" data-testid="run-history">
    <header class="head">
      <h2>{{ t('runs.history.title') }}</h2>
      <BaseButton
        size="sm"
        variant="ghost"
        :loading="loading"
        data-testid="run-history-refresh"
        @click="emit('refresh')"
      >
        {{ t('common.refresh') }}
      </BaseButton>
    </header>
    <p v-if="!entries.length" class="note">{{ t('runs.history.empty') }}</p>
    <ul v-else class="list">
      <li v-for="entry in entries" :key="entry.runId">
        <button
          type="button"
          class="row"
          :data-testid="`run-history-open-${entry.runId}`"
          :disabled="busyId === entry.runId"
          @click="emit('open', entry.runId)"
        >
          <span class="badge" :data-status="entry.status">{{ t(`runs.status.${entry.status}`) }}</span>
          <span class="goal" :title="entry.goalPreview">{{ entry.goalPreview }}</span>
          <span class="meta">
            {{ entry.itemsDone }}/{{ entry.itemsTotal }} · {{ entry.turns }} {{ t('runs.turns') }} · {{ cost(entry) }}
          </span>
          <span class="when">{{ when(entry) }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.card {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
  background: var(--bg-elev);
  padding: 14px;
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.head h2 {
  margin: 0;
  font-size: 15px;
  flex: 1;
}
.note {
  color: var(--text-dim);
  font-size: 12px;
  margin: 10px 0 0;
}
.list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow: auto;
}
.row {
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  gap: 10px;
  align-items: center;
  width: 100%;
  text-align: left;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
  padding: 7px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.row:hover {
  border-color: var(--accent, #60a5fa);
}
.goal {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta,
.when {
  color: var(--text-dim);
  white-space: nowrap;
}
.badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-dim);
  text-transform: uppercase;
}
.badge[data-status='completed'] {
  color: var(--ok, #4ade80);
  border-color: currentColor;
}
.badge[data-status='running'] {
  color: var(--accent, #60a5fa);
  border-color: currentColor;
}
.badge[data-status='blocked'],
.badge[data-status='failed'] {
  color: var(--danger, #f87171);
  border-color: currentColor;
}
</style>
