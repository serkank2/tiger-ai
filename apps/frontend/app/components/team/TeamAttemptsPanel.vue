<script setup lang="ts">
import { computed } from 'vue';
import { useTeamStore } from '~/stores/team';
import { useT } from '~/composables/useT';
import type { TeamAttemptSnapshot, TeamAttemptStatus } from '~/types';
import BaseButton from '~/components/ui/BaseButton.vue';

// Lets the parent open the diff drawer when an attempt's diff is requested.
const emit = defineEmits<{ 'view-diff': [attemptId: string] }>();

const team = useTeamStore();
const { t } = useT();

const attempts = computed<TeamAttemptSnapshot[]>(() => team.attempts);
const readOnly = computed(() => team.readOnly);
const promotedId = computed(() => team.promotedAttemptId);
// One promotion per run — once any attempt is promoted, hide the others' Promote buttons.
const hasPromotion = computed(() => promotedId.value != null);

const STATUS_KEY: Record<TeamAttemptStatus, string> = {
  running: 'team.status.running',
  completed: 'team.status.completed',
  failed: 'team.status.failed',
  promoted: 'team.attempts.promotedStatus',
  superseded: 'team.attempts.supersededStatus',
};

/** Only a finished, non-promoted attempt with a branch can be promoted. */
function canPromote(a: TeamAttemptSnapshot): boolean {
  return (
    !readOnly.value &&
    !hasPromotion.value &&
    !a.promoted &&
    !!a.branch &&
    (a.status === 'completed' || a.status === 'failed' || a.status === 'superseded')
  );
}

function summaryLabel(a: TeamAttemptSnapshot): string {
  if (!a.summary) return t('team.attempts.noDiff');
  const { files, insertions, deletions } = a.summary;
  return `${files} file${files === 1 ? '' : 's'}; +${insertions}; -${deletions}`;
}

async function startNewAttempt(): Promise<void> {
  await team.createAttempt().catch(() => {});
}

async function promote(a: TeamAttemptSnapshot): Promise<void> {
  await team.promoteAttempt(a.id).catch(() => {});
}

function viewDiff(a: TeamAttemptSnapshot): void {
  void team.loadAttemptDiff(a.id).catch(() => {});
  emit('view-diff', a.id);
}
</script>

<template>
  <details class="attempts" open>
    <summary>{{ t('team.attempts.title') }} <span v-if="attempts.length" class="n">{{ attempts.length }}</span></summary>

    <div class="a-body">
      <ul v-if="attempts.length" class="a-list">
        <li
          v-for="a in attempts"
          :key="a.id"
          class="attempt"
          :class="{ current: a.current, promoted: a.promoted }"
        >
          <div class="a-row">
            <span class="a-num">#{{ a.attemptNumber }}</span>
            <span class="a-status" :class="`st-${a.status}`">{{ t(STATUS_KEY[a.status]) }}</span>
            <span v-if="a.current" class="a-tag cur">{{ t('team.attempts.current') }}</span>
            <span v-if="a.promoted" class="a-tag prom">{{ t('team.attempts.promoted') }}</span>
          </div>
          <div class="a-meta">
            <span class="a-sum">{{ summaryLabel(a) }}</span>
            <span v-if="a.branch" class="a-branch" :title="a.branch">Branch: {{ a.branch }}</span>
          </div>
          <div class="a-actions">
            <BaseButton size="sm" variant="ghost" :title="t('team.attempts.viewDiffTitle')" @click="viewDiff(a)">{{ t('team.attempts.diff') }}</BaseButton>
            <BaseButton
              v-if="canPromote(a)"
              size="sm"
              variant="primary"
              :loading="team.isBusy(`attempt-promote:${a.id}`)"
              :title="t('team.attempts.promoteTitle')"
              @click="promote(a)"
            >{{ t('team.attempts.promote') }}</BaseButton>
          </div>
        </li>
      </ul>
      <p v-else class="empty">
        {{ t('team.attempts.empty') }}
      </p>

      <BaseButton
        v-if="!readOnly"
        size="sm"
        variant="secondary"
        class="new-attempt"
        :loading="team.isBusy('attempt-new')"
        :title="t('team.attempts.newTitle')"
        @click="startNewAttempt"
      >{{ t('team.attempts.newAttempt') }}</BaseButton>
    </div>
  </details>
</template>

<style scoped>
.attempts {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-sm);
}
summary {
  cursor: pointer;
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
}
summary .n { color: var(--text-faint); }
.a-body { margin-top: var(--space-2); display: flex; flex-direction: column; gap: var(--space-2); }
.a-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.attempt {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.attempt.current { border-color: var(--accent); }
.attempt.promoted { border-color: var(--green); }
.a-row { display: flex; align-items: center; gap: var(--space-2); }
.a-num { font-weight: 700; font-variant-numeric: tabular-nums; }
.a-status {
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
}
.st-running { color: var(--accent); }
.st-completed, .st-promoted { color: var(--green); }
.st-failed { color: var(--red); }
.st-superseded { color: var(--slate); }
.a-tag {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-strong);
}
.a-tag.cur { color: var(--accent); border-color: var(--accent); }
.a-tag.prom { color: var(--green); border-color: var(--green); }
.a-meta { display: flex; gap: var(--space-2); font-size: var(--text-xs); color: var(--text-dim); flex-wrap: wrap; }
.a-sum { font-variant-numeric: tabular-nums; }
.a-branch {
  font-family: var(--font-mono, monospace);
  color: var(--text-faint);
  max-width: 22ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.a-actions { display: flex; gap: var(--space-2); margin-top: 2px; }
.empty { margin: 0; font-size: var(--text-xs); color: var(--text-faint); }
.new-attempt { align-self: flex-start; }
</style>
