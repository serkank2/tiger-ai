<script setup lang="ts">
import type { TerminalDto } from '~/types';
import { lastOutputLine } from '~/lib/terminalPreview';

const props = defineProps<{ terminal: TerminalDto }>();
const terminals = useTerminalsStore();

const root = ref<HTMLElement | null>(null);
const host = ref<HTMLElement | null>(null);
const running = computed(
  () => props.terminal.status.state === 'running' || props.terminal.status.state === 'starting',
);
const isActive = computed(() => terminals.activeId === props.terminal.id);

// --- Grid virtualization -------------------------------------------------
// Only on-screen tiles mount a live xterm + WS attach; off-screen tiles tear
// down (the backend keeps scrollback and replays it on re-attach, so this is
// lossless). The active tile is always kept live so focus/input never drops
// even if the user scrolls it out of view. Off-screen tiles still render a
// lightweight placeholder (name/status/last line) so the grid layout is intact.
const onScreen = ref(false);
const live = computed(() => onScreen.value || isActive.value);
// The id handed to useTerminalView: real id while live, null when suspended.
// Flipping to null triggers the composable's clean teardown (detach + dispose).
const liveId = computed(() => (live.value ? props.terminal.id : null));

useTerminalView(host, liveId, { compact: true });

// Last non-empty line of the captured preview, shown on suspended tiles.
const lastLine = computed(() => lastOutputLine(props.terminal.lastOutput));

let io: IntersectionObserver | null = null;
onMounted(() => {
  // No IntersectionObserver (e.g. test env): degrade to always-live so behavior
  // matches the pre-virtualization grid for small terminal counts.
  if (typeof IntersectionObserver === 'undefined' || !root.value) {
    onScreen.value = true;
    return;
  }
  io = new IntersectionObserver(
    (entries) => {
      const entry = entries[entries.length - 1];
      if (entry) onScreen.value = entry.isIntersecting;
    },
    // Pre-mount a viewport's worth above/below so scrolling reveals a live tile,
    // not a flash of placeholder.
    { root: null, rootMargin: '300px 0px', threshold: 0 },
  );
  io.observe(root.value);
});
onBeforeUnmount(() => {
  io?.disconnect();
  io = null;
});

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
    ref="root"
    class="tile"
    :class="{ active: isActive, suspended: !live }"
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
      <button class="ic" title="Expand to single view" @click="expand">⛶</button>
    </div>
    <div class="tile-body">
      <!-- Live xterm host: only mounted while the tile is on-screen / active. -->
      <div v-show="live" ref="host" class="term" data-testid="tile-term" />
      <!-- Suspended placeholder: keeps the grid layout + a hint of recent output. -->
      <div v-if="!live" class="tile-placeholder" data-testid="tile-placeholder">
        <span class="ph-state">{{ terminal.status.state }}</span>
        <span v-if="lastLine" class="ph-last">{{ lastLine }}</span>
        <span v-else class="ph-idle">scrolled out of view</span>
      </div>
      <div v-else-if="!running" class="tile-hint">{{ terminal.status.state }} — ▶ to start</div>
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
.tile-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  padding: 10px 14px;
  overflow: hidden;
}
.ph-state {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
}
.ph-last {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ph-idle {
  font-size: 11px;
  color: var(--text-faint);
  font-style: italic;
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
