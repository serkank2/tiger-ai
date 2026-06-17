<script setup lang="ts">
import { strictestLimit } from '~/lib/shellLimits';
import type { BroadcastOutcome } from '~/composables/useSocket';

const emit = defineEmits<{ create: []; manageGroups: []; openSettings: []; openComposer: []; openTiger: [] }>();
const terminals = useTerminalsStore();
const groups = useGroupsStore();
const conn = useConnectionStore();
const socket = useSocket();
const notices = useNoticesStore();

const cmd = ref('');

const targetCount = computed(() => {
  // count only deliverable (unprotected) targets — protected terminals are skipped server-side
  if (terminals.commandMode === 'selected') return terminals.unprotectedIds(terminals.selectedIds).length;
  if (terminals.commandMode === 'group') {
    return terminals.commandGroupId
      ? terminals.items.filter((t) => t.groupId === terminals.commandGroupId && !t.protected).length
      : 0;
  }
  return terminals.items.filter((t) => !t.protected).length;
});

const canSend = computed(() => {
  if (conn.status !== 'connected') return false;
  if (terminals.commandMode === 'group' && !terminals.commandGroupId) return false;
  return targetCount.value > 0;
});

// Long-input guard: a shell truncates a single command line (cmd ~8191, PowerShell ~16K;
// bash/zsh/custom effectively unbounded). Warn (never block) past the strictest target limit.
const targetTerminals = computed(() => {
  // protected terminals never receive the command, so they don't affect the length warning
  if (terminals.commandMode === 'selected')
    return terminals.items.filter((t) => terminals.selectedIds.includes(t.id) && !t.protected);
  if (terminals.commandMode === 'group')
    return terminals.commandGroupId
      ? terminals.items.filter((t) => t.groupId === terminals.commandGroupId && !t.protected)
      : [];
  return terminals.items.filter((t) => !t.protected);
});
const inputLimit = computed(() => strictestLimit(targetTerminals.value.map((t) => t.shell?.kind)));
const lengthWarning = computed(() => {
  const len = cmd.value.length;
  if (Number.isFinite(inputLimit.value) && len > inputLimit.value) {
    return `${len} characters - the target shell may truncate the command near the ${inputLimit.value} character limit. For very long content, write it to a file and run it from there.`;
  }
  return null;
});

function broadcastFailureMessage(result: BroadcastOutcome): string | null {
  switch (result.kind) {
    case 'ok':
      return null;
    case 'not_sent':
      return result.reason === 'server_error'
        ? `Command not sent: ${result.message ?? 'the backend rejected the request.'}`
        : 'Command not sent: the socket is not connected.';
    case 'timeout':
      return 'Command status unknown: no broadcast confirmation was received within 5 seconds.';
    case 'disconnected':
      return 'Command status unknown: the socket disconnected before confirming delivery.';
  }
}

async function send() {
  if (!canSend.value) return;
  const result = await socket.broadcast(terminals.buildTarget(), cmd.value);
  const failureMessage = broadcastFailureMessage(result);
  if (failureMessage) notices.push(failureMessage, 'error');
  // keep the input for retry if nothing actually ran (all targets failed, or not sent)
  if (result.kind === 'ok' && result.written > 0) cmd.value = '';
}

// one-click control keys sent to the current target (raw byte, no trailing newline)
const QUICK_KEYS = [
  { label: '^C', char: '\x03', title: 'Ctrl+C (interrupt)' },
  { label: '^D', char: '\x04', title: 'Ctrl+D (EOF)' },
  { label: 'Esc', char: '\x1b', title: 'Escape' },
];
function sendKey(ch: string) {
  if (!canSend.value) return;
  void socket.broadcast(terminals.buildTarget(), ch, false);
}
</script>

<template>
  <header class="bar">
    <div class="brand">
      <span class="logo">🐅</span>
      <b>Kaplan</b>
      <span class="conn" :class="conn.status" :title="`backend ${conn.status}`" />
    </div>

    <div class="target">
      <div class="seg">
        <button :class="{ on: terminals.commandMode === 'selected' }" @click="terminals.commandMode = 'selected'">
          Selected<span class="n">{{ terminals.selectedIds.length }}</span>
        </button>
        <button :class="{ on: terminals.commandMode === 'group' }" @click="terminals.commandMode = 'group'">Group</button>
        <button :class="{ on: terminals.commandMode === 'all' }" @click="terminals.commandMode = 'all'">All</button>
      </div>
      <select v-if="terminals.commandMode === 'group'" v-model="terminals.commandGroupId" class="gsel">
        <option :value="null" disabled>Choose group…</option>
        <option v-for="g in groups.groups" :key="g.id" :value="g.id">{{ g.name }}</option>
      </select>
      <button class="iconbtn" title="Manage groups" aria-label="Manage groups" @click="emit('manageGroups')">🗂</button>
      <button class="iconbtn" title="Settings" aria-label="Settings" @click="emit('openSettings')">⚙</button>
    </div>

    <form class="cmd" @submit.prevent="send">
      <input v-model="cmd" :placeholder="`Send command to ${targetCount} terminal(s)…`" spellcheck="false" />
      <button type="submit" class="send" :disabled="!canSend">Send ⏎</button>
      <p v-if="lengthWarning" class="lenwarn">⚠ {{ lengthWarning }}</p>
    </form>

    <button class="iconbtn" title="Open prompt composer" aria-label="Open prompt composer" @click="emit('openComposer')">⤢</button>

    <div class="keys">
      <button
        v-for="k in QUICK_KEYS"
        :key="k.label"
        type="button"
        class="key"
        :disabled="!canSend"
        :title="`Send ${k.title} to ${terminals.commandMode}`"
        @click="sendKey(k.char)"
      >
        {{ k.label }}
      </button>
    </div>

    <div class="seg layout">
      <button :class="{ on: terminals.layoutMode === 'focus' }" title="Single focused terminal" aria-label="Focus view" @click="terminals.layoutMode = 'focus'">▭</button>
      <button :class="{ on: terminals.layoutMode === 'grid' }" title="Tiled grid view" aria-label="Grid view" @click="terminals.layoutMode = 'grid'">▦</button>
    </div>

    <button class="tiger" title="Open the Tiger AI orchestrator" @click="emit('openTiger')">🐅 Tiger</button>
    <button class="new" @click="emit('create')">+ New Terminal</button>
  </header>
</template>

<style scoped>
.bar {
  height: var(--bar-h);
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 16px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
}
.logo {
  font-size: 18px;
}
.conn {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--slate);
}
.conn.connected {
  background: var(--green);
  box-shadow: 0 0 8px var(--green);
}
.conn.connecting {
  background: var(--amber);
  animation: blink 1s infinite;
}
.conn.disconnected {
  background: var(--red);
}
@keyframes blink {
  50% {
    opacity: 0.3;
  }
}
.target {
  display: flex;
  align-items: center;
  gap: 8px;
}
.iconbtn {
  border: 1px solid var(--border-strong);
  width: 32px;
  height: 32px;
  color: var(--text-dim);
  flex: none;
}
.iconbtn:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.seg {
  display: flex;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.seg button {
  padding: 6px 11px;
  font-size: 12px;
  color: var(--text-dim);
  border-radius: 0;
  border-right: 1px solid var(--border);
}
.seg button:last-child {
  border-right: none;
}
.seg button.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.seg .n {
  margin-left: 5px;
  opacity: 0.8;
}
.cmd {
  flex: 1;
  display: flex;
  gap: 8px;
  position: relative;
}
.lenwarn {
  position: absolute;
  top: calc(100% + 5px);
  left: 0;
  right: 0;
  z-index: 20;
  margin: 0;
  padding: 6px 10px;
  font-size: 11px;
  line-height: 1.35;
  color: var(--amber);
  background: var(--bg-elev);
  border: 1px solid var(--amber);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
}
.cmd input {
  flex: 1;
  font-family: var(--font-mono);
}
.send {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #1b1206;
  font-weight: 700;
  padding: 7px 14px;
}
.send:hover:not(:disabled) {
  background: var(--accent-strong);
}
.send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.keys {
  display: flex;
  gap: 4px;
}
.key {
  border: 1px solid var(--border-strong);
  padding: 7px 9px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-dim);
}
.key:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.key:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.new {
  border: 1px solid var(--border-strong);
  padding: 7px 12px;
  font-weight: 600;
  color: var(--text);
}
.new:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.tiger {
  border: 1px solid var(--accent);
  color: var(--accent);
  padding: 7px 12px;
  font-weight: 700;
  flex: none;
}
.tiger:hover {
  background: var(--accent-soft);
}
</style>
