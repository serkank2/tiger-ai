<script setup lang="ts">
// Indeterminate loading indicator. Accessible by default: when `label` is set it
// exposes role="status" with screen-reader text; pass an empty label to render it
// decoratively (e.g. inside a BaseButton that already has its own label).
const props = withDefaults(
  defineProps<{
    /** Diameter — a number is treated as px, a string is used verbatim. */
    size?: number | string;
    /** Screen-reader label. Empty string renders the spinner as decorative. */
    label?: string;
  }>(),
  { size: 18, label: 'Loading…' },
);

const dim = computed(() => (typeof props.size === 'number' ? `${props.size}px` : props.size));
</script>

<template>
  <span
    class="spinner"
    :style="{ width: dim, height: dim }"
    :role="label ? 'status' : undefined"
    :aria-hidden="label ? undefined : 'true'"
  >
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle class="track" cx="12" cy="12" r="9" stroke-width="3" />
      <path class="arc" d="M21 12a9 9 0 0 0-9-9" stroke-width="3" stroke-linecap="round" />
    </svg>
    <span v-if="label" class="sr-only">{{ label }}</span>
  </span>
</template>

<style scoped>
.spinner {
  display: inline-flex;
  flex: none;
  vertical-align: middle;
}
.spinner svg {
  width: 100%;
  height: 100%;
  animation: spin 0.7s linear infinite;
}
.track {
  stroke: var(--border-strong);
}
.arc {
  stroke: var(--accent);
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@media (prefers-reduced-motion: reduce) {
  .spinner svg {
    animation-duration: 1.6s;
  }
}
</style>
