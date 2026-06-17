<script setup lang="ts">
defineProps<{ label?: string; small?: boolean }>();
</script>

<template>
  <span class="spinner-wrap" :class="{ small }" role="status" :aria-label="label || 'Loading'">
    <span class="spinner" aria-hidden="true" />
    <span v-if="label" class="label">{{ label }}</span>
  </span>
</template>

<style scoped>
.spinner-wrap {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-dim);
  font-size: 13px;
}
.spinner-wrap.small {
  gap: 6px;
  font-size: 12px;
}
.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex: none;
}
.small .spinner {
  width: 13px;
  height: 13px;
}
.label {
  white-space: nowrap;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
