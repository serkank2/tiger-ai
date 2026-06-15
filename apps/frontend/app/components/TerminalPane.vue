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
let onData: IDisposable | null = null;
let onResize: IDisposable | null = null;
let ro: ResizeObserver | null = null;
let mountedId: string | null = null;

function teardown() {
  if (mountedId) socket.detach(mountedId);
  offOutput?.();
  onData?.dispose();
  onResize?.dispose();
  ro?.disconnect();
  term?.dispose();
  offOutput = onData = onResize = ro = term = fit = null;
  mountedId = null;
}

async function mount(id: string) {
  teardown();
  await nextTick();
  if (!host.value) return;

  term = new Terminal({
    cursorBlink: true,
    fontFamily: "'Cascadia Code', 'JetBrains Mono', ui-monospace, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.15,
    scrollback: 8000,
    theme: THEME,
    allowProposedApi: true,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(host.value);
  safeFit();

  offOutput = socket.onOutput(id, (data) => term?.write(data));
  onData = term.onData((data) => socket.input(id, data));
  onResize = term.onResize(({ cols, rows }) => socket.resize(id, cols, rows));
  mountedId = id;
  socket.attach(id); // server replays the scrollback buffer

  await nextTick();
  safeFit();
  if (term) socket.resize(id, term.cols, term.rows);
  term?.focus();

  ro = new ResizeObserver(() => safeFit());
  ro.observe(host.value);
}

function safeFit() {
  try {
    fit?.fit();
  } catch {
    /* element not measurable yet */
  }
}

watch(
  () => terminals.activeId,
  (id) => {
    if (id) mount(id);
    else teardown();
  },
);
onMounted(() => {
  if (terminals.activeId) mount(terminals.activeId);
});
onBeforeUnmount(() => teardown());
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
