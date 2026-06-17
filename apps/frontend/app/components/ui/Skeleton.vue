<script setup lang="ts">
// Decorative loading placeholder (shimmer). Always aria-hidden — the surrounding
// surface is responsible for announcing busy state (e.g. via a Spinner/role=status).
const props = withDefaults(
  defineProps<{
    width?: string;
    height?: string;
    /** Corner radius. Ignored when `circle` is set. */
    radius?: string;
    circle?: boolean;
    /** When > 1, render stacked text-line placeholders (last line is shortened). */
    lines?: number;
  }>(),
  { width: '100%', height: '1em', circle: false, lines: 1 },
);

const blockRadius = computed(() => props.radius ?? 'var(--radius-sm, 6px)');
const single = computed(() => ({
  width: props.circle ? (props.width !== '100%' ? props.width : props.height) : props.width,
  height: props.height,
  borderRadius: props.circle ? 'var(--radius-full, 999px)' : blockRadius.value,
}));
</script>

<template>
  <span v-if="lines > 1" class="skel-lines" aria-hidden="true">
    <span
      v-for="n in lines"
      :key="n"
      class="skel"
      :style="{ height, borderRadius: blockRadius, width: n === lines ? '70%' : '100%' }"
    />
  </span>
  <span v-else class="skel" :style="single" aria-hidden="true" />
</template>

<style scoped>
.skel {
  display: block;
  background: linear-gradient(90deg, var(--bg-elev) 25%, var(--bg-elev-2) 37%, var(--bg-elev) 63%);
  background-size: 400% 100%;
  animation: shimmer 1.4s ease-in-out infinite;
}
.skel-lines {
  display: flex;
  flex-direction: column;
  gap: var(--space-2, 8px);
}
@keyframes shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: 0 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .skel {
    animation: none;
  }
}
</style>
