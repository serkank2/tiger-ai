<script setup lang="ts">
function backToTerminals() {
  void navigateTo('/terminals');
}
</script>

<template>
  <PromptsView @back="backToTerminals" />
</template>
