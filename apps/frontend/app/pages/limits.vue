<script setup lang="ts">
import LimitsView from '~/components/limits/LimitsView.vue';

function backToTerminals() {
  void navigateTo('/terminals');
}
</script>

<template>
  <LimitsView @back="backToTerminals" />
</template>
