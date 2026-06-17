<script setup lang="ts">
import type { TigerTaskSummary } from '~/types';

defineProps<{ tasks: TigerTaskSummary | null; loading?: boolean }>();

const EXEC = [
  { k: 'not_started', label: 'not started' },
  { k: 'in_progress', label: 'in progress' },
  { k: 'done', label: 'done' },
  { k: 'blocked', label: 'blocked' },
] as const;
const REVIEW = [
  { k: 'pending', label: 'pending' },
  { k: 'reviewing', label: 'reviewing' },
  { k: 'approved', label: 'approved' },
  { k: 'needs_fix', label: 'needs fix' },
  { k: 'fixed', label: 'fixed' },
] as const;
</script>

<template>
  <div v-if="loading" class="loading-board">
    <Spinner small label="Loading tasks" />
    <Skeleton :lines="5" />
  </div>

  <div v-else-if="tasks && tasks.total" class="board">
    <div class="summary">
      <div class="group">
        <span class="gl">Execution</span>
        <span v-for="e in EXEC" :key="e.k" class="chip" :class="`ex-${e.k}`">
          {{ e.label }}<b>{{ tasks.byExecution[e.k] }}</b>
        </span>
      </div>
      <div class="group">
        <span class="gl">Review</span>
        <span v-for="r in REVIEW" :key="r.k" class="chip" :class="`rv-${r.k}`">
          {{ r.label }}<b>{{ tasks.byReview[r.k] }}</b>
        </span>
      </div>
    </div>
    <div class="rows">
      <div v-for="t in tasks.items" :key="t.id" class="row">
        <code class="id">{{ t.id }}</code>
        <span class="title">{{ t.title }}</span>
        <span class="spacer" />
        <span v-if="t.assignedAgent && t.assignedAgent !== '-'" class="agent">{{ t.assignedAgent }}</span>
        <span class="badge" :class="`ex-${t.executionStatus}`">{{ t.executionStatus.replace('_', ' ') }}</span>
        <span class="badge" :class="`rv-${t.reviewStatus}`">{{ t.reviewStatus.replace('_', ' ') }}</span>
      </div>
    </div>
  </div>
  <EmptyState v-else title="No tasks yet." description="Run the Merge Tasks stage to produce the authoritative task list." />
</template>

<style scoped>
.loading-board {
  display: grid;
  gap: 12px;
  padding: 8px 0;
}
.board {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}
.group {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.gl {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
}
.chip {
  font-size: 11px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 8px;
}
.chip b {
  margin-left: 5px;
  color: var(--text);
}
.rows {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  max-height: 260px;
  overflow-y: auto;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.row:last-child {
  border-bottom: none;
}
.id {
  font-family: var(--font-mono);
  color: var(--accent);
  flex: none;
}
.title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.spacer {
  flex: 1;
}
.agent {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-faint);
}
.badge {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
  white-space: nowrap;
}
.ex-done,
.rv-approved,
.rv-fixed {
  color: var(--green);
  border-color: var(--green);
}
.ex-in_progress,
.rv-reviewing {
  color: var(--accent);
  border-color: var(--accent);
}
.ex-blocked,
.rv-needs_fix {
  color: var(--red);
  border-color: var(--red);
}
</style>
