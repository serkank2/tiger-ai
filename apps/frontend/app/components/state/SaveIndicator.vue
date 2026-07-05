<script setup lang="ts">
// Inline persistence-state indicator (saving / saved / error / idle). Pairs with
// StateView for the lighter "is my edit committed?" feedback every editable panel
// needs. Purely presentational — the parent owns the state machine.
import { computed } from 'vue';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const props = defineProps<{
  state: SaveState;
  /** Optional override for the error/label text. */
  message?: string;
}>();

const LABELS: Record<SaveState, string> = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Save failed',
};

const label = computed(() => props.message ?? LABELS[props.state]);
const visible = computed(() => props.state !== 'idle');
</script>

<template>
  <span
    v-if="visible"
    class="save-indicator"
    :class="state"
    role="status"
    :aria-live="state === 'error' ? 'assertive' : 'polite'"
  >
    <span v-if="state === 'saving'" class="spinner" aria-hidden="true" />
    <span v-else-if="state === 'saved'" class="glyph" aria-hidden="true">✓</span>
    <span v-else-if="state === 'error'" class="glyph" aria-hidden="true">⚠</span>
    <span class="label">{{ label }}</span>
  </span>
</template>

<style scoped>
.save-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.save-indicator.saved {
  color: var(--green);
}
.save-indicator.error {
  color: var(--red);
}
.glyph {
  font-weight: 700;
}
.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
