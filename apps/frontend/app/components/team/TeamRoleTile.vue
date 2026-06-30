<script setup lang="ts">
import { computed, ref } from 'vue';
import { useT } from '~/composables/useT';
import type { RoleSnapshot } from '~/types';
import TeamAgentBadge from './TeamAgentBadge.vue';

const props = defineProps<{ role: RoleSnapshot; displayName?: string }>();
const emit = defineEmits<{ select: [] }>();
const { t } = useT();

const hasTerminal = computed(() => !!props.role.terminalId);
const label = computed(() => props.displayName ?? props.role.name);

const STATUS_KEY: Record<string, string> = {
  idle: 'team.roleTile.status.idle',
  thinking: 'team.roleTile.status.thinking',
  working: 'team.roleTile.status.working',
  waiting: 'team.roleTile.status.waiting',
  blocked: 'team.status.blocked',
  done: 'team.controls.done',
  failed: 'team.status.failed',
};

const statusLabel = computed(() => t(STATUS_KEY[props.role.status] ?? props.role.status));
const isActive = computed(() => props.role.status === 'working' || props.role.status === 'thinking');
const root = ref<HTMLElement | null>(null);

function select(): void {
  if (hasTerminal.value) emit('select');
}

function onTileKeydown(ev: KeyboardEvent): void {
  if (ev.target !== root.value) return;
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  ev.preventDefault();
  select();
}
</script>

<template>
  <div
    ref="root"
    class="role-tile"
    :class="[`s-${role.status}`, { signed: role.signedOff, clickable: hasTerminal }]"
    :role="hasTerminal ? 'button' : undefined"
    :tabindex="hasTerminal ? 0 : undefined"
    :title="hasTerminal ? t('team.roleTile.openAgentTerminal') : undefined"
    @click="select"
    @keydown="onTileKeydown"
  >
    <span class="dot" :class="{ pulse: isActive }" />
    <div class="body">
      <div class="line">
        <TeamAgentBadge :tool="role.tool" />
        <span class="name" :title="label">{{ label }}</span>
        <span v-if="hasTerminal" class="term-ic" :title="t('team.roleTile.openTerminal')">Terminal</span>
        <span v-if="role.signedOff" class="check" :title="t('team.roleTile.signedOff')">Signed</span>
      </div>
      <div class="meta">
        <span class="status">{{ statusLabel }}</span>
        <span v-if="role.turnCount" class="turns" :title="t('team.roleTile.turnsTaken', { n: role.turnCount })"
          >Turns {{ role.turnCount }}</span
        >
        <span v-if="role.canWriteCode" class="flag write" :title="t('team.roleTile.mayEditSource')">{{
          t('team.roleTile.code')
        }}</span>
        <span v-if="role.requiredForSignoff" class="flag sign" :title="t('team.roleTile.requiredSignoff')">{{
          t('team.roleTile.signoff')
        }}</span>
      </div>
      <div v-if="role.tasks && (role.tasks.todo || role.tasks.inProgress || role.tasks.done)" class="tasks">
        <span v-if="role.tasks.todo" class="tq todo" :title="t('team.roleTile.queuedTasks')"
          >Todo {{ role.tasks.todo }}</span
        >
        <span v-if="role.tasks.inProgress" class="tq prog" :title="t('team.roleTile.inProgress')"
          >Active {{ role.tasks.inProgress }}</span
        >
        <span v-if="role.tasks.done" class="tq done" :title="t('team.roleTile.completedTasks')"
          >Done {{ role.tasks.done }}</span
        >
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
  /* Smoothly animate status changes (idle→thinking→working→…): the border + background
     shift colour, and the status dot (below) cross-fades its colour with the same token. */
  transition:
    border-color var(--dur-base) var(--ease-standard),
    background-color var(--dur-base) var(--ease-standard);
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
  font-size: var(--text-xs);
  opacity: 0.75;
}
.role-tile.s-working {
  border-color: var(--accent);
}
.role-tile.s-blocked {
  border-color: var(--amber);
}
.role-tile.s-failed {
  border-color: var(--red);
}
.role-tile.signed {
  border-color: var(--green);
}
.dot {
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: var(--radius-pill);
  background: var(--slate);
  flex: none;
  transition: background-color var(--dur-base) var(--ease-standard);
}
.s-working .dot,
.s-thinking .dot {
  background: var(--accent);
}
.s-blocked .dot {
  background: var(--amber);
}
.s-failed .dot {
  background: var(--red);
}
.s-done .dot,
.signed .dot {
  background: var(--green);
}
.dot.pulse {
  animation: pulse 1.4s var(--ease-in-out) infinite;
}
@keyframes pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 50%, transparent);
  }
  50% {
    box-shadow: 0 0 0 5px transparent;
  }
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
.flag.write {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}
.flag.sign {
  color: var(--green);
  border-color: color-mix(in srgb, var(--green) 40%, transparent);
}
.tasks {
  display: flex;
  gap: var(--space-2);
  margin-top: 4px;
}
.tq {
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-faint);
}
.tq.prog {
  color: var(--accent);
}
.tq.done {
  color: var(--green);
}
.note {
  margin: 4px 0 0;
  font-size: var(--text-xs);
  color: var(--text-dim);
  line-height: var(--leading-snug);
}
</style>
