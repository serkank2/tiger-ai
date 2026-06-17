<script setup lang="ts">
// Neutral "nothing here yet" / "couldn't load" surface. Use the `actions` slot for
// a primary call-to-action (e.g. a BaseButton) and the `icon` slot for custom art.
defineProps<{
  title?: string;
  description?: string;
  /** Convenience text/emoji icon; use the `icon` slot for richer content. */
  icon?: string;
  /** Render with the danger accent (for failed-to-load states). */
  tone?: 'default' | 'danger';
}>();
</script>

<template>
  <div class="empty" :class="{ danger: tone === 'danger' }">
    <div v-if="icon || $slots.icon" class="empty-icon" aria-hidden="true">
      <slot name="icon">{{ icon }}</slot>
    </div>
    <p v-if="title" class="empty-title">{{ title }}</p>
    <p v-if="description || $slots.default" class="empty-desc">
      <slot>{{ description }}</slot>
    </p>
    <div v-if="$slots.actions" class="empty-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: var(--space-2, 8px);
  padding: var(--space-8, 32px) var(--space-5, 20px);
  color: var(--text-dim);
}
.empty-icon {
  font-size: var(--text-2xl, 28px);
  line-height: 1;
  color: var(--text-faint);
  margin-bottom: var(--space-1, 4px);
}
.danger .empty-icon {
  color: var(--red);
}
.empty-title {
  margin: 0;
  font-size: var(--text-md, 14px);
  font-weight: 600;
  color: var(--text);
}
.empty-desc {
  margin: 0;
  max-width: 42ch;
  font-size: var(--text-sm, 13px);
  line-height: var(--leading-normal, 1.5);
  color: var(--text-dim);
}
.empty-actions {
  display: flex;
  gap: var(--space-2, 8px);
  margin-top: var(--space-3, 12px);
}
</style>
