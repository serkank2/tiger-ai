<script setup lang="ts">
// Projects home: the Tiger AI orchestrator, relocated from the old view toggle into
// its own route. TigerView keeps its live `tiger.state` WebSocket behavior; the only
// change is that "back" now returns to the Terminals route via the shell.
function back() {
  void navigateTo('/terminals');
}

function openTemplates() {
  void navigateTo('/templates');
}
</script>

<template>
  <div class="tiger-page">
    <TigerView @back="back" @open-templates="openTemplates" />
  </div>
</template>

<style scoped>
.tiger-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.tiger-page :deep(.tiger) {
  flex: 1;
}
</style>
