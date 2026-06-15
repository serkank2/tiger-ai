<script setup lang="ts">
const emit = defineEmits<{ create: [] }>();
const terminals = useTerminalsStore();
const groups = useGroupsStore();
const conn = useConnectionStore();
const socket = useSocket();

const cmd = ref('');

const targetCount = computed(() => {
  if (terminals.commandMode === 'selected') return terminals.selectedIds.length;
  if (terminals.commandMode === 'group') {
    return terminals.commandGroupId
      ? terminals.items.filter((t) => t.groupId === terminals.commandGroupId).length
      : 0;
  }
  return terminals.items.length;
});

const canSend = computed(() => {
  if (terminals.commandMode === 'group' && !terminals.commandGroupId) return false;
  return targetCount.value > 0;
});

function send() {
  if (!canSend.value) return;
  socket.broadcast(terminals.buildTarget(), cmd.value);
  cmd.value = '';
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
    </div>

    <form class="cmd" @submit.prevent="send">
      <input v-model="cmd" :placeholder="`Send command to ${targetCount} terminal(s)…`" spellcheck="false" />
      <button type="submit" class="send" :disabled="!canSend">Send ⏎</button>
    </form>

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
</style>
