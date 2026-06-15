<script setup lang="ts">
import type { TerminalDto } from '~/types';

const props = defineProps<{ terminal: TerminalDto; active: boolean; selected: boolean }>();
const emit = defineEmits<{
  select: [];
  toggle: [];
  start: [];
  stop: [];
  restart: [];
  edit: [];
  remove: [];
}>();

const running = computed(
  () => props.terminal.status.state === 'running' || props.terminal.status.state === 'starting',
);

// two-step delete confirm (no native dialog)
const confirming = ref(false);
let resetTimer: ReturnType<typeof setTimeout> | null = null;
function onDelete() {
  if (confirming.value) {
    confirming.value = false;
    if (resetTimer) clearTimeout(resetTimer);
    emit('remove');
  } else {
    confirming.value = true;
    resetTimer = setTimeout(() => (confirming.value = false), 2500);
  }
}
</script>

<template>
  <div class="item" :class="{ active }" @click="emit('select')">
    <input class="chk" type="checkbox" :checked="selected" @click.stop @change="emit('toggle')" />
    <StatusDot :state="terminal.status.state" />
    <div class="meta">
      <div class="name">{{ terminal.name }}</div>
      <div class="cwd" :title="terminal.cwd">{{ terminal.cwd }}</div>
      <div v-if="terminal.lastOutput" class="out">{{ terminal.lastOutput }}</div>
    </div>
    <div class="actions" @click.stop>
      <button v-if="!running" class="ic" title="Start" @click="emit('start')">▶</button>
      <button v-else class="ic" title="Stop" @click="emit('stop')">■</button>
      <button class="ic" title="Restart" @click="emit('restart')">⟳</button>
      <button class="ic" title="Edit" @click="emit('edit')">✎</button>
      <button class="ic danger" :class="{ confirm: confirming }" :title="confirming ? 'Click again to delete' : 'Delete'" @click="onDelete">
        {{ confirming ? '✓?' : '🗑' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 9px 12px 9px 10px;
  border-left: 2px solid transparent;
  cursor: pointer;
  position: relative;
}
.item:hover {
  background: var(--bg-elev-2);
}
.item.active {
  background: var(--accent-soft);
  border-left-color: var(--accent);
}
.chk {
  margin-top: 3px;
  accent-color: var(--accent);
  flex: none;
}
.meta {
  min-width: 0;
  flex: 1;
}
.name {
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cwd {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
}
.out {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 3px;
  opacity: 0.8;
}
.actions {
  display: none;
  gap: 2px;
  flex: none;
}
.item:hover .actions,
.item.active .actions {
  display: flex;
}
.ic {
  width: 26px;
  height: 26px;
  font-size: 12px;
  color: var(--text-dim);
  display: grid;
  place-items: center;
}
.ic:hover {
  background: var(--bg);
  color: var(--text);
}
.ic.danger:hover {
  color: var(--red);
}
.ic.confirm {
  color: var(--red);
  border-color: var(--red);
}
</style>
