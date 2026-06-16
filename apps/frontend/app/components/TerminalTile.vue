<script setup lang="ts">
import type { TerminalDto } from '~/types';

const props = defineProps<{ terminal: TerminalDto }>();
const terminals = useTerminalsStore();

const host = ref<HTMLElement | null>(null);
const idRef = computed(() => props.terminal.id);
const running = computed(
  () => props.terminal.status.state === 'running' || props.terminal.status.state === 'starting',
);
const isActive = computed(() => terminals.activeId === props.terminal.id);

useTerminalView(host, idRef, { compact: true });

function activate() {
  terminals.setActive(props.terminal.id);
}
function expand() {
  terminals.setActive(props.terminal.id);
  terminals.layoutMode = 'focus';
}
</script>

<template>
  <div
    class="tile"
    :class="{ active: isActive }"
    tabindex="0"
    role="group"
    :aria-label="`Terminal ${terminal.name}`"
    @mousedown="activate"
    @focusin="activate"
    @keydown.enter="activate"
  >
    <div class="tile-head">
      <StatusDot :state="terminal.status.state" />
      <span class="tname">{{ terminal.name }}</span>
      <span class="spacer" />
      <button v-if="!running" class="ic" title="Start" @click="terminals.start(terminal.id)">▶</button>
      <button v-else class="ic" title="Stop" @click="terminals.stop(terminal.id)">■</button>
      <button class="ic" title="Restart" @click="terminals.restart(terminal.id)">⟳</button>
      <button class="ic" title="Open full screen" @click="expand">⛶</button>
    </div>
    <div class="tile-body">
      <div ref="host" class="term" />
      <div v-if="!running" class="tile-hint">{{ terminal.status.state }} — ▶ to start</div>
    </div>
  </div>
</template>

<style scoped>
.tile {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-term);
}
.tile.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.tile:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.tile-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 8px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
}
.tname {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.spacer {
  flex: 1;
}
.ic {
  width: 22px;
  height: 22px;
  font-size: 11px;
  color: var(--text-dim);
  display: grid;
  place-items: center;
}
.ic:hover {
  background: var(--bg);
  color: var(--text);
}
.tile-body {
  flex: 1;
  min-height: 0;
  position: relative;
  padding: 4px 2px 4px 6px;
}
.term {
  width: 100%;
  height: 100%;
}
.tile-hint {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  padding: 3px 10px;
  font-size: 11px;
  color: var(--text-dim);
  background: var(--bg-elev-2);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  pointer-events: none;
}
</style>
