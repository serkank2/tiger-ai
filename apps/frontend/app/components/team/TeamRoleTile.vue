<script setup lang="ts">
import { computed } from 'vue';
import type { RoleSnapshot } from '~/types';
import TeamAgentBadge from './TeamAgentBadge.vue';

const props = defineProps<{ role: RoleSnapshot }>();

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
  <div class="role-tile" :class="[`s-${role.status}`, { signed: role.signedOff }]">
    <span class="dot" :class="{ pulse: isActive }" />
    <div class="body">
      <div class="line">
        <TeamAgentBadge :tool="role.tool" />
        <span class="name" :title="role.name">{{ role.name }}</span>
        <span v-if="role.signedOff" class="check" title="Signed off">✓</span>
      </div>
      <div class="meta">
        <span class="status">{{ statusLabel }}</span>
        <span v-if="role.canWriteCode" class="flag write" title="Can write code">code</span>
        <span v-if="role.requiredForSignoff" class="flag sign" title="Required for sign-off">sign-off</span>
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
  0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 66, 0.5); }
  50% { box-shadow: 0 0 0 5px rgba(245, 158, 66, 0); }
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
.flag {
  font-size: 10px;
  border-radius: var(--radius-pill);
  padding: 0 6px;
  border: 1px solid var(--border-strong);
  color: var(--text-faint);
}
.flag.write { color: var(--accent); border-color: rgba(245, 158, 66, 0.4); }
.flag.sign { color: var(--green); border-color: rgba(108, 197, 108, 0.4); }
.note {
  margin: 4px 0 0;
  font-size: var(--text-xs);
  color: var(--text-dim);
  line-height: var(--leading-snug);
}
</style>
