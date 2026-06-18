<script setup lang="ts">
import LimitStatusChip from '~/components/limits/LimitStatusChip.vue';

function openLimits() {
  void navigateTo('/limits');
}
</script>

<template>
  <LimitStatusChip @open="openLimits" />
</template>
