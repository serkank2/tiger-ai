<script setup lang="ts">
// AI Team home: role agents (business analyst, developer, tester, …) that talk to
// one another in a company-chat view, build the project, and only stop once every
// required role has signed off. TeamView owns all live `team.*` WebSocket behavior.
function back() {
  void navigateTo('/terminals');
}
</script>

<template>
  <div class="team-page">
    <TeamView @back="back" />
  </div>
</template>

<style scoped>
.team-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.team-page :deep(.team) {
  flex: 1;
}
</style>
