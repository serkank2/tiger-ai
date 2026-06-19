<script setup lang="ts">
import { computed } from 'vue';
import type { RoleSnapshot } from '~/types';
import TeamAgentBadge from './TeamAgentBadge.vue';

const props = defineProps<{ role: RoleSnapshot }>();
const emit = defineEmits<{ select: [] }>();

const hasTerminal = computed(() => !!props.role.terminalId);

const STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  working: 'Working',
  waiting: 'Waiting',
  blocked: 'Blocked',
  done: 'Done',
  failed: 'Failed',
};

const statusLabel = computed(() => STATUS_LABEL[props.role.status] ?? props.role.status);
const isActive = computed(() => props.role.status === 'working' || props.role.status === 'thinking');
</script>

<template>
  <div
    class="role-tile"
    :class="[`s-${role.status}`, { signed: role.signedOff, clickable: hasTerminal }]"
    :role="hasTerminal ? 'button' : undefined"
    :tabindex="hasTerminal ? 0 : undefined"
    :title="hasTerminal ? 'Open the agent terminal' : undefined"
    @click="hasTerminal && emit('select')"
    @keydown.enter="hasTerminal && emit('select')"
  >
    <span class="dot" :class="{ pulse: isActive }" />
    <div class="body">
      <div class="line">
        <TeamAgentBadge :tool="role.tool" />
        <span class="name" :title="role.name">{{ role.name }}</span>
        <span v-if="hasTerminal" class="term-ic" title="Open terminal">🖥</span>
        <span v-if="role.signedOff" class="check" title="Signed off">✓</span>
      </div>
      <div class="meta">
        <span class="status">{{ statusLabel }}</span>
        <span v-if="role.turnCount" class="turns" :title="`${role.turnCount} turn(s) taken`">×{{ role.turnCount }}</span>
        <span v-if="role.canWriteCode" class="flag write" title="May edit project source">code</span>
        <span v-if="role.requiredForSignoff" class="flag sign" title="Required for sign-off">sign-off</span>
      </div>
      <div v-if="role.tasks && (role.tasks.todo || role.tasks.inProgress || role.tasks.done)" class="tasks">
        <span v-if="role.tasks.todo" class="tq todo" title="Queued tasks">▤ {{ role.tasks.todo }}</span>
        <span v-if="role.tasks.inProgress" class="tq prog" title="In progress">▸ {{ role.tasks.inProgress }}</span>
        <span v-if="role.tasks.done" class="tq done" title="Completed tasks">✓ {{ role.tasks.done }}</span>
      </div>
      <p v-if="role.statusNote" class="note">{{ role.statusNote }}</p>
    </div>
  </div>
</template>

<style scoped>
.role-tile {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  transition: border-color var(--dur-base) var(--ease-standard);
}
.role-tile.clickable {
  cursor: pointer;
}
.role-tile.clickable:hover {
  border-color: var(--accent);
  background: var(--bg-elev-2);
}
.role-tile:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.term-ic {
  font-size: 11px;
  opacity: 0.75;
}
.role-tile.s-working { border-color: var(--accent); }
.role-tile.s-blocked { border-color: var(--amber); }
.role-tile.s-failed { border-color: var(--red); }
.role-tile.signed { border-color: var(--green); }
.dot {
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: var(--radius-pill);
  background: var(--slate);
  flex: none;
}
.s-working .dot, .s-thinking .dot { background: var(--accent); }
.s-blocked .dot { background: var(--amber); }
.s-failed .dot { background: var(--red); }
.s-done .dot, .signed .dot { background: var(--green); }
.dot.pulse {
  animation: pulse 1.4s var(--ease-in-out) infinite;
}
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 50%, transparent); }
  50% { box-shadow: 0 0 0 5px transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .dot.pulse {
    animation: none;
  }
}
.body {
  min-width: 0;
  flex: 1;
}
.line {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
}
.name {
  font-weight: 600;
  font-size: var(--text-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.check {
  margin-left: auto;
  color: var(--green);
  font-weight: 700;
}
.meta {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  margin-top: 3px;
}
.status {
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.turns {
  font-size: var(--text-xs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.flag {
  font-size: var(--text-xs);
  border-radius: var(--radius-pill);
  padding: 0 6px;
  border: 1px solid var(--border-strong);
  color: var(--text-faint);
}
.flag.write { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.flag.sign { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
.tasks {
  display: flex;
  gap: var(--space-2);
  margin-top: 4px;
}
.tq {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--text-faint);
}
.tq.prog { color: var(--accent); }
.tq.done { color: var(--green); }
.note {
  margin: 4px 0 0;
  font-size: var(--text-xs);
  color: var(--text-dim);
  line-height: var(--leading-snug);
}
</style>
