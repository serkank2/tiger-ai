<script setup lang="ts">
defineProps<{ title: string; description?: string; tone?: 'neutral' | 'error' }>();
</script>

<template>
  <div class="empty-state" :class="tone ?? 'neutral'">
    <p class="title">{{ title }}</p>
    <p v-if="description" class="desc">{{ description }}</p>
    <div v-if="$slots.default" class="actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: grid;
  justify-items: center;
  gap: 7px;
  padding: 22px;
  text-align: center;
  color: var(--text-faint);
}
.title {
  margin: 0;
  color: var(--text-dim);
  font-weight: 700;
}
.desc {
  margin: 0;
  max-width: 60ch;
  color: var(--text-faint);
  font-size: 13px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.error .title {
  color: var(--red);
}
.actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 4px;
}
</style>
