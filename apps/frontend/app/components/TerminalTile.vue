<script setup lang="ts">
import type { TerminalDto } from '~/types';
import { lastOutputLine } from '~/lib/terminalPreview';
import BaseButton from '~/components/ui/BaseButton.vue';
import { useT } from '~/composables/useT';

const { t } = useT();
const props = defineProps<{ terminal: TerminalDto }>();
const terminals = useTerminalsStore();

// Local pending guard so the lifecycle controls show feedback and can't be
// double-clicked during the async start/stop/restart transition.
const pending = ref(false);
async function runLifecycle(action: () => unknown | Promise<unknown>) {
  if (pending.value) return;
  pending.value = true;
  try {
    await action();
  } finally {
    pending.value = false;
  }
}

const root = ref<HTMLElement | null>(null);
const host = ref<HTMLElement | null>(null);
const running = computed(() => props.terminal.status.state === 'running' || props.terminal.status.state === 'starting');
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
function onTileKeydown(ev: KeyboardEvent) {
  if (ev.target !== root.value) return;
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  ev.preventDefault();
  activate();
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
    :class="[`st-${terminal.status.state}`, { active: isActive, suspended: !live, live }]"
    tabindex="0"
    role="group"
    :aria-label="t('terminals.tile.terminalAria', { name: terminal.name })"
    @mousedown="activate"
    @focusin="activate"
    @keydown="onTileKeydown"
  >
    <div class="tile-head">
      <StatusDot :state="terminal.status.state" />
      <span class="tname">{{ terminal.name }}</span>
      <span class="state-text">{{ terminal.status.state }}</span>
      <span class="spacer" />
      <BaseButton
        v-if="!running"
        class="ic"
        size="sm"
        variant="ghost"
        icon-only
        :aria-label="t('terminals.actions.startTerminal')"
        :title="t('terminals.actions.start')"
        :loading="pending"
        @click="runLifecycle(() => terminals.start(terminal.id))"
        >▶</BaseButton
      >
      <BaseButton
        v-else
        class="ic"
        size="sm"
        variant="ghost"
        icon-only
        :aria-label="t('terminals.actions.stopTerminal')"
        :title="t('terminals.actions.stop')"
        :loading="pending"
        @click="runLifecycle(() => terminals.stop(terminal.id))"
        >■</BaseButton
      >
      <BaseButton
        class="ic"
        size="sm"
        variant="ghost"
        icon-only
        :aria-label="t('terminals.actions.restartTerminal')"
        :title="t('terminals.actions.restart')"
        :loading="pending"
        @click="runLifecycle(() => terminals.restart(terminal.id))"
        >⟳</BaseButton
      >
      <BaseButton
        class="ic"
        size="sm"
        variant="ghost"
        icon-only
        :aria-label="t('terminals.actions.expandToSingle')"
        :title="t('terminals.actions.expandToSingle')"
        @click="expand"
        >⛶</BaseButton
      >
    </div>
    <div class="tile-body">
      <!-- Live xterm host: only mounted while the tile is on-screen / active. -->
      <div v-show="live" ref="host" class="term" data-testid="tile-term" />
      <!-- Suspended placeholder: keeps the grid layout + a hint of recent output. -->
      <div v-if="!live" class="tile-placeholder" data-testid="tile-placeholder">
        <span class="ph-state">{{ terminal.status.state }}</span>
        <span v-if="lastLine" class="ph-last">{{ lastLine }}</span>
        <span v-else class="ph-idle">{{ t('terminals.tile.scrolledOut') }}</span>
      </div>
      <div v-else-if="!running" class="tile-hint">{{ terminal.status.state }} — ▶ to start</div>
    </div>
  </div>
</template>

<style scoped>
.tile {
  position: relative;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-elev) 18%, transparent), transparent 42%), var(--bg-term);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--text) 6%, transparent),
    0 8px 22px color-mix(in srgb, var(--bg) 40%, transparent);
  transition:
    border-color var(--dur-base) var(--ease-standard),
    background-color var(--dur-base) var(--ease-standard);
}
.tile::before,
.tile::after {
  content: '';
  position: absolute;
  pointer-events: none;
}
.tile::before {
  inset: 0;
  border-radius: inherit;
  z-index: 3;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 5%, transparent);
  opacity: 0.55;
  transition: opacity var(--dur-base) var(--ease-standard);
}
.tile::after {
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 4;
  width: 3px;
  background: var(--slate);
  opacity: 0.68;
  transition:
    background-color var(--dur-base) var(--ease-standard),
    opacity var(--dur-base) var(--ease-standard);
}
.tile.active {
  border-color: var(--accent);
  box-shadow:
    0 0 0 1px var(--accent),
    0 0 0 4px var(--accent-soft),
    0 12px 30px color-mix(in srgb, var(--accent) 12%, transparent);
}
.tile.active::before {
  opacity: 0.95;
}
.tile:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.tile.st-running::after {
  background: var(--green);
  opacity: 0.95;
}
.tile.st-starting::after {
  background: var(--amber);
  opacity: 0.95;
}
.tile.st-failed::after {
  background: var(--red);
  opacity: 0.95;
}
.tile.st-stopped::after,
.tile.st-exited::after {
  background: var(--slate);
  opacity: 0.5;
}
.tile.suspended {
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--bg-elev) 30%, transparent), transparent 56%), var(--bg-term);
}
.tile.suspended::before {
  background: repeating-linear-gradient(
    135deg,
    color-mix(in srgb, var(--border) 34%, transparent) 0 1px,
    transparent 1px 9px
  );
  opacity: 0.38;
}
.tile.live.st-running::after,
.tile.live.st-starting::after {
  animation: state-rail 2.4s var(--ease-in-out) infinite;
}
.tile-head {
  position: relative;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 8px;
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 7%, transparent), transparent 44%),
    color-mix(in srgb, var(--bg-elev) 94%, var(--bg) 6%);
  border-bottom: 1px solid var(--border);
}
.tname {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.state-text {
  flex: none;
  max-width: 82px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--border-strong) 78%, transparent);
  border-radius: var(--radius-pill);
  color: var(--text-faint);
  background: color-mix(in srgb, var(--bg-elev-2) 70%, transparent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1.35;
  text-transform: uppercase;
}
.st-running .state-text {
  color: var(--green);
  border-color: color-mix(in srgb, var(--green) 42%, transparent);
  background: color-mix(in srgb, var(--green) 10%, transparent);
}
.st-starting .state-text {
  color: var(--amber);
  border-color: color-mix(in srgb, var(--amber) 42%, transparent);
  background: color-mix(in srgb, var(--amber) 10%, transparent);
}
.st-failed .state-text {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 42%, transparent);
  background: color-mix(in srgb, var(--red) 10%, transparent);
}
.spacer {
  flex: 1;
}
/* Compact lifecycle controls in the dense tile header. BaseButton handles
   focus-visible/disabled/aria; we only tighten the icon-only square size. */
.ic.btn {
  width: 22px;
  height: 22px;
  font-size: 11px;
}
.tile-body {
  flex: 1;
  min-height: 0;
  position: relative;
  z-index: 1;
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
  background:
    radial-gradient(circle at 18px 18px, color-mix(in srgb, var(--accent) 14%, transparent), transparent 28px),
    linear-gradient(180deg, color-mix(in srgb, var(--bg-elev) 42%, transparent), transparent);
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
  box-shadow: 0 6px 18px color-mix(in srgb, var(--bg) 34%, transparent);
  pointer-events: none;
}
@media (hover: hover) {
  .tile:hover::before {
    opacity: 0.86;
  }
  .tile:hover .tile-head {
    background:
      linear-gradient(90deg, color-mix(in srgb, var(--accent) 11%, transparent), transparent 48%),
      color-mix(in srgb, var(--bg-elev-2) 76%, var(--bg-elev) 24%);
  }
}
@keyframes state-rail {
  0%,
  100% {
    opacity: 0.72;
  }
  50% {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .tile.live.st-running::after,
  .tile.live.st-starting::after {
    animation: none;
  }
}
</style>
