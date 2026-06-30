<script setup lang="ts">
import { computed } from 'vue';
import { useT } from '~/composables/useT';
import type { DoneGateState } from '~/types';

const { t } = useT();

const props = defineProps<{
  gate: DoneGateState;
  status: string | null;
  message?: string | null;
}>();

const total = computed(() => props.gate.requiredRoleIds.length);
const signed = computed(() => props.gate.signedOffRoleIds.length);
const pct = computed(() => (total.value ? Math.round((signed.value / total.value) * 100) : 0));
const done = computed(() => props.status === 'completed');

// Why the run is not done yet — the full gate, not just sign-offs.
const blockers = computed(() => props.gate.openBlockers ?? []);
const BLOCKER_KEY: Record<string, string> = {
  tasks_blocked: 'team.doneGate.blockers.tasksBlocked',
  tasks_incomplete: 'team.doneGate.blockers.tasksIncomplete',
  findings_open: 'team.doneGate.blockers.findingsOpen',
  verification_missing: 'team.doneGate.blockers.verificationMissing',
  verification_failed: 'team.doneGate.blockers.verificationFailed',
  steering_pending: 'team.doneGate.blockers.steeringPending',
  no_signoff_roles: 'team.doneGate.blockers.noSignoffRoles',
  signoff_missing: 'team.doneGate.blockers.signoffMissing',
  signoff_stale: 'team.doneGate.blockers.signoffStale',
  board_pending: 'team.doneGate.blockers.boardPending',
};
function blockerLabel(code: string): string {
  return t(BLOCKER_KEY[code] ?? code);
}
</script>

<template>
  <div class="done-gate" :class="{ satisfied: gate.satisfied, completed: done }">
    <div class="head">
      <span class="title">{{ t('team.doneGate.title') }}</span>
      <span class="frac">{{ t('team.doneGate.signedOff', { signed, total }) }}</span>
    </div>
    <div
      class="bar"
      role="progressbar"
      :aria-valuenow="signed"
      aria-valuemin="0"
      :aria-valuemax="total"
      :aria-label="t('team.doneGate.progressLabel', { signed, total })"
    >
      <div class="fill" :style="{ width: `${pct}%` }" />
    </div>
    <p v-if="done" class="state ok">{{ t('team.doneGate.complete') }}</p>
    <p v-else-if="status === 'blocked'" class="state warn">{{ t('team.doneGate.blocked') }}</p>
    <p v-else-if="status === 'failed'" class="state err">{{ t('team.doneGate.failed') }}</p>
    <p v-else-if="gate.pendingRoleIds.length" class="state">
      {{ t('team.doneGate.waiting', { n: gate.pendingRoleIds.length }) }}
    </p>
    <p v-else class="state">{{ t('team.doneGate.tracking') }}</p>

    <ul v-if="blockers.length" class="blockers" :aria-label="t('team.doneGate.openBlockers')">
      <li v-for="b in blockers" :key="b.code" class="blocker" :title="b.message">
        <span class="bcode" :class="`bc-${b.code}`">{{ blockerLabel(b.code) }}</span>
        <span class="bmsg">{{ b.message }}</span>
      </li>
    </ul>

    <p v-if="message" class="msg">{{ message }}</p>
  </div>
</template>

<style scoped>
.done-gate {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-3);
}
.done-gate.completed {
  border-color: var(--green);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.title {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
}
.frac {
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.bar {
  margin-top: var(--space-2);
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--bg-elev-2);
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--accent);
  transition: width var(--dur-slow) var(--ease-standard);
}
.completed .fill,
.satisfied .fill {
  background: var(--green);
}
.state {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  color: var(--text-dim);
  line-height: var(--leading-snug);
}
.state.ok {
  color: var(--green);
}
.state.warn {
  color: var(--amber);
}
.state.err {
  color: var(--red);
}
.blockers {
  list-style: none;
  margin: var(--space-2) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.blocker {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: var(--space-1) var(--space-2);
  border-left: 2px solid var(--amber);
  background: var(--bg-elev-2);
  border-radius: var(--radius-sm);
}
.bcode {
  font-size: var(--text-xs);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--amber);
}
.bmsg {
  font-size: var(--text-xs);
  color: var(--text-dim);
  line-height: var(--leading-snug);
}
.msg {
  margin: var(--space-1) 0 0;
  font-size: var(--text-xs);
  color: var(--text-faint);
}
</style>
