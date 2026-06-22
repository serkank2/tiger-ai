<script setup lang="ts">
import type { TigerTaskSummary } from '~/types';
import Spinner from '~/components/ui/Spinner.vue';
import Skeleton from '~/components/ui/Skeleton.vue';
import EmptyState from '~/components/ui/EmptyState.vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import { useT } from '~/composables/useT';

defineProps<{ tasks: TigerTaskSummary | null; loading?: boolean; error?: string | null }>();
const emit = defineEmits<{ retry: [] }>();

const { t } = useT();

const EXEC = [
  { k: 'not_started' },
  { k: 'in_progress' },
  { k: 'done' },
  { k: 'blocked' },
] as const;
const REVIEW = [
  { k: 'pending' },
  { k: 'reviewing' },
  { k: 'approved' },
  { k: 'needs_fix' },
  { k: 'fixed' },
] as const;
</script>

<template>
  <div v-if="loading" class="loading-board">
    <Spinner :size="14" :label="t('tiger.taskBoard.loading')" />
    <Skeleton :lines="5" />
  </div>

  <div v-else-if="error" class="board">
    <EmptyState
      tone="danger"
      icon="⚠️"
      :title="t('tiger.taskBoard.errorStateTitle')"
      :description="error"
    >
      <template #actions>
        <BaseButton variant="secondary" @click="emit('retry')">{{ t('tiger.taskBoard.retry') }}</BaseButton>
      </template>
    </EmptyState>
  </div>

  <div v-else-if="tasks && tasks.total" class="board">
    <div class="summary">
      <div class="group">
        <span class="gl">{{ t('tiger.taskBoard.execution') }}</span>
        <span v-for="e in EXEC" :key="e.k" class="chip" :class="`ex-${e.k}`">
          {{ t('tiger.taskBoard.executionStatus.' + e.k) }}<b>{{ tasks.byExecution[e.k] }}</b>
        </span>
      </div>
      <div class="group">
        <span class="gl">{{ t('tiger.taskBoard.review') }}</span>
        <span v-for="r in REVIEW" :key="r.k" class="chip" :class="`rv-${r.k}`">
          {{ t('tiger.taskBoard.reviewStatus.' + r.k) }}<b>{{ tasks.byReview[r.k] }}</b>
        </span>
      </div>
    </div>
    <div class="rows">
      <div v-for="item in tasks.items" :key="item.id" class="row">
        <code class="id">{{ item.id }}</code>
        <span class="title">{{ item.title }}</span>
        <span class="spacer" />
        <span v-if="item.assignedAgent && item.assignedAgent !== '-'" class="agent">{{ item.assignedAgent }}</span>
        <span class="badge" :class="`ex-${item.executionStatus}`">{{ t('tiger.taskBoard.executionStatus.' + item.executionStatus) }}</span>
        <span class="badge" :class="`rv-${item.reviewStatus}`">{{ t('tiger.taskBoard.reviewStatus.' + item.reviewStatus) }}</span>
      </div>
    </div>
  </div>
  <EmptyState v-else :title="t('tiger.taskBoard.emptyStateTitle')" :description="t('tiger.taskBoard.emptyStateDesc')" />
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
