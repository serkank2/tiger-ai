<script setup lang="ts">
import type { TerminalDto } from '~/types';

const terminals = useTerminalsStore();
const groups = useGroupsStore();
const settings = useSettingsStore();
const socket = useSocket();

const showEditor = ref(false);
const editing = ref<TerminalDto | null>(null);

function openCreate() {
  editing.value = null;
  showEditor.value = true;
}
function openEdit(t: TerminalDto) {
  editing.value = t;
  showEditor.value = true;
}

let poll: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  socket.connect();
  try {
    await Promise.all([terminals.fetchAll(), groups.load(), settings.load()]);
  } catch (err) {
    console.error('[kaplan] initial load failed (is the backend running?)', err);
  }
  // Refresh last-output previews periodically (live status arrives via WebSocket).
  poll = setInterval(() => void terminals.refreshPreviews().catch(() => {}), 4000);
});
onBeforeUnmount(() => {
  if (poll) clearInterval(poll);
});
</script>

<template>
  <div class="app">
    <CommandBar @create="openCreate" />
    <div class="body">
      <TerminalSidebar @create="openCreate" @edit="openEdit" />
      <TerminalPane />
    </div>
    <TerminalEditModal
      v-if="showEditor"
      :terminal="editing"
      @close="showEditor = false"
      @saved="terminals.fetchAll()"
    />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.body {
  display: flex;
  flex: 1;
  min-height: 0;
  position: relative;
}
</style>
