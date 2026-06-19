<script setup lang="ts">
import { computed } from 'vue';
import type { DoneGateState } from '~/types';

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
const BLOCKER_LABEL: Record<string, string> = {
  tasks_blocked: 'Tasks blocked',
  tasks_incomplete: 'Tasks incomplete',
  findings_open: 'Open findings',
  verification_missing: 'Verification missing',
  verification_failed: 'Verification failed',
  steering_pending: 'Steering pending',
  no_signoff_roles: 'No sign-off roles',
  signoff_missing: 'Sign-off missing',
  signoff_stale: 'Sign-off stale',
  board_pending: 'Task board pending',
};
function blockerLabel(code: string): string {
  return BLOCKER_LABEL[code] ?? code;
}
</script>

<template>
  <div class="done-gate" :class="{ satisfied: gate.satisfied, completed: done }">
    <div class="head">
      <span class="title">Completion gate</span>
      <span class="frac">{{ signed }}/{{ total }} signed off</span>
    </div>
    <div
      class="bar"
      role="progressbar"
      :aria-valuenow="signed"
      aria-valuemin="0"
      :aria-valuemax="total"
      :aria-label="`${signed} of ${total} roles signed off`"
    >
      <div class="fill" :style="{ width: `${pct}%` }" />
    </div>
    <p v-if="done" class="state ok">✓ Every required role signed off — the work is complete.</p>
    <p v-else-if="status === 'blocked'" class="state warn">⚠ Blocked — the team needs steering to proceed.</p>
    <p v-else-if="status === 'failed'" class="state err">✕ Run failed.</p>
    <p v-else-if="gate.pendingRoleIds.length" class="state">
      Waiting on {{ gate.pendingRoleIds.length }} role(s) to confirm the work is done.
    </p>
    <p v-else class="state">Tracking progress…</p>

    <ul v-if="blockers.length" class="blockers" aria-label="Open completion blockers">
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
.done-gate.completed { border-color: var(--green); }
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
.completed .fill, .satisfied .fill { background: var(--green); }
.state {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  color: var(--text-dim);
  line-height: var(--leading-snug);
}
.state.ok { color: var(--green); }
.state.warn { color: var(--amber); }
.state.err { color: var(--red); }
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
  font-size: 10px;
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
