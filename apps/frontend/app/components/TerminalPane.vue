<script setup lang="ts">
import { Terminal, type IDisposable, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

const terminals = useTerminalsStore();
const socket = useSocket();

const host = ref<HTMLElement | null>(null);
const active = computed(() => terminals.active);
const running = computed(
  () => active.value?.status.state === 'running' || active.value?.status.state === 'starting',
);

const THEME: ITheme = {
  background: '#0f0d0a',
  foreground: '#ece6db',
  cursor: '#fb923c',
  cursorAccent: '#0f0d0a',
  selectionBackground: 'rgba(245,158,66,0.30)',
  black: '#15130f',
  red: '#e5564b',
  green: '#6cc56c',
  yellow: '#e0b03a',
  blue: '#5aa9e6',
  magenta: '#c08cd6',
  cyan: '#5bc2b8',
  white: '#cfc7b8',
  brightBlack: '#6f6557',
  brightRed: '#ff6f63',
  brightGreen: '#84d784',
  brightYellow: '#f0c34e',
  brightBlue: '#74bdf5',
  brightMagenta: '#d6a6e8',
  brightCyan: '#74d8cd',
  brightWhite: '#ece6db',
};

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let offOutput: (() => void) | null = null;
let offSnapshot: (() => void) | null = null;
let onData: IDisposable | null = null;
let onResize: IDisposable | null = null;
let ro: ResizeObserver | null = null;
let mountedId: string | null = null;
let mountToken = 0; // guards against overlapping async mounts on rapid switches

function teardown() {
  if (mountedId) socket.detach(mountedId);
  offOutput?.();
  offSnapshot?.();
  onData?.dispose();
  onResize?.dispose();
  ro?.disconnect();
  term?.dispose();
  offOutput = offSnapshot = onData = onResize = ro = term = fit = null;
  mountedId = null;
}

function safeFit() {
  try {
    fit?.fit();
  } catch {
    /* element not measurable yet */
  }
}

function isTypingElsewhere(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

async function mount(id: string) {
  const token = ++mountToken;
  teardown();
  await nextTick();
  if (token !== mountToken || !host.value) return; // superseded or unmounted

  const t = new Terminal({
    cursorBlink: true,
    fontFamily: "'Cascadia Code', 'JetBrains Mono', ui-monospace, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.15,
    scrollback: 8000,
    theme: THEME,
    allowProposedApi: true,
  });
  const f = new FitAddon();
  t.loadAddon(f);
  t.loadAddon(new WebLinksAddon());
  t.open(host.value);

  // commit to instance state — this mount is the current one
  term = t;
  fit = f;
  mountedId = id;

  safeFit();
  // register listeners BEFORE attach so the snapshot/replay isn't missed.
  // snapshot = full buffer on (re)attach: reset first so reconnects don't duplicate.
  offSnapshot = socket.onSnapshot(id, (data) => {
    t.reset();
    t.write(data);
  });
  offOutput = socket.onOutput(id, (data) => t.write(data));
  onData = t.onData((data) => socket.input(id, data));
  onResize = t.onResize(({ cols, rows }) => socket.resize(id, cols, rows));
  socket.resize(id, t.cols, t.rows); // size the pty before the server replays
  socket.attach(id);

  await nextTick();
  if (token !== mountToken) return; // a newer mount took over during the await
  safeFit();
  socket.resize(id, t.cols, t.rows);
  if (!isTypingElsewhere()) t.focus();

  ro = new ResizeObserver(() => {
    if (token === mountToken) safeFit();
  });
  ro.observe(host.value);
}

watch(
  () => terminals.activeId,
  (id) => {
    if (id) void mount(id);
    else {
      mountToken++; // cancel any in-flight mount
      teardown();
    }
  },
);
onMounted(() => {
  if (terminals.activeId) void mount(terminals.activeId);
});
onBeforeUnmount(() => {
  mountToken++; // cancel any in-flight mount
  teardown();
});
</script>

<template>
  <section class="pane">
    <div v-if="active" class="phead">
      <StatusDot :state="active.status.state" label />
      <span class="pname">{{ active.name }}</span>
      <span class="pcwd" :title="active.cwd">{{ active.cwd }}</span>
      <span v-if="active.status.pid" class="ppid">pid {{ active.status.pid }}</span>
      <span
        v-if="active.status.exitCode !== null && active.status.exitCode !== undefined && !running"
        class="pexit"
        :class="{ bad: active.status.exitCode !== 0 }"
      >
        exit {{ active.status.exitCode }}
      </span>
      <span class="spacer" />
      <button v-if="!running" class="pbtn go" @click="terminals.start(active.id)">▶ Start</button>
      <button v-else class="pbtn" @click="terminals.stop(active.id)">■ Stop</button>
      <button class="pbtn" @click="terminals.restart(active.id)">⟳ Restart</button>
    </div>

    <div class="term-wrap">
      <div ref="host" class="term" />
      <div v-if="active && !running" class="stopped-hint">
        {{ active.status.state }} — press <b>▶ Start</b> to interact
      </div>
    </div>

    <div v-if="!active" class="noactive">
      <p>Select a terminal on the left,<br />or create one to begin.</p>
    </div>
  </section>
</template>

<style scoped>
.pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-term);
}
.phead {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 14px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
}
.pname {
  font-weight: 700;
}
.pcwd {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40%;
}
.ppid,
.pexit {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-faint);
  padding: 2px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
}
.pexit.bad {
  color: var(--red);
  border-color: var(--red);
}
.spacer {
  flex: 1;
}
.pbtn {
  border: 1px solid var(--border-strong);
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
}
.pbtn:hover {
  color: var(--text);
  border-color: var(--text-faint);
}
.pbtn.go {
  color: var(--accent);
  border-color: var(--accent);
}
.pbtn.go:hover {
  background: var(--accent-soft);
}
.term-wrap {
  flex: 1;
  min-height: 0;
  padding: 8px 4px 8px 10px;
  position: relative;
}
.stopped-hint {
  position: absolute;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  padding: 5px 14px;
  font-size: 12px;
  color: var(--text-dim);
  background: var(--bg-elev-2);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  pointer-events: none;
}
.term {
  width: 100%;
  height: 100%;
}
.noactive {
  position: absolute;
  inset: var(--bar-h) 0 0 var(--sidebar-w);
  display: grid;
  place-items: center;
  color: var(--text-faint);
  text-align: center;
  pointer-events: none;
}
</style>
