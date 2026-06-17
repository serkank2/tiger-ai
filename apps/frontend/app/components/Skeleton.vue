<script setup lang="ts">
withDefaults(defineProps<{ lines?: number }>(), { lines: 1 });
</script>

<template>
  <div class="skeleton" aria-hidden="true">
    <span v-for="i in lines" :key="i" class="line" :style="{ width: `${92 - ((i - 1) % 3) * 14}%` }" />
  </div>
</template>

<style scoped>
.skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.line {
  display: block;
  height: 12px;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--bg-elev-2), var(--border), var(--bg-elev-2));
  background-size: 220% 100%;
  animation: shimmer 1.2s ease-in-out infinite;
}
@keyframes shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: -100% 0;
  }
}
</style>
