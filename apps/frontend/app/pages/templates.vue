<script setup lang="ts">
function back() {
  void navigateTo('/terminals');
}

function openTiger() {
  void navigateTo('/tiger');
}
</script>

<template>
  <div class="templates-route">
    <TemplatesView @back="back" @open-tiger="openTiger" />
  </div>
</template>

<style scoped>
.templates-route {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
</style>
