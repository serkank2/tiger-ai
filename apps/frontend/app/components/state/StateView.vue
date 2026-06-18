<script setup lang="ts">
// Shared cross-cutting state panel. One component covers the recurring lifecycle
// states every screen needs (empty, loading, error, disconnected, blocked,
// retrying, canceled, recovery) so screens render them consistently instead of
// each hand-rolling its own markup.
import { computed } from 'vue';

export type StateKind =
  | 'empty'
  | 'loading'
  | 'error'
  | 'disconnected'
  | 'blocked'
  | 'retrying'
  | 'canceled'
  | 'recovery';

type Tone = 'neutral' | 'info' | 'warn' | 'error' | 'success';

const props = defineProps<{
  kind: StateKind;
  title?: string;
  description?: string;
  /** Render compactly (inline within a panel) instead of a tall centered block. */
  compact?: boolean;
}>();

interface Preset {
  icon: string;
  title: string;
  tone: Tone;
  busy?: boolean;
}

const PRESETS: Record<StateKind, Preset> = {
  empty: { icon: '∅', title: 'Nothing here yet', tone: 'neutral' },
  loading: { icon: '', title: 'Loading…', tone: 'neutral', busy: true },
  error: { icon: '⚠', title: 'Something went wrong', tone: 'error' },
  disconnected: { icon: '⛌', title: 'Disconnected', tone: 'warn' },
  blocked: { icon: '⛔', title: 'Blocked', tone: 'warn' },
  retrying: { icon: '', title: 'Retrying…', tone: 'info', busy: true },
  canceled: { icon: '✕', title: 'Canceled', tone: 'neutral' },
  recovery: { icon: '⟲', title: 'Recovering…', tone: 'info', busy: true },
};

const preset = computed(() => PRESETS[props.kind]);
const heading = computed(() => props.title ?? preset.value.title);
</script>

<template>
  <div class="state-view" :class="[preset.tone, { compact }]" role="status" :aria-busy="preset.busy || undefined">
    <span v-if="preset.busy" class="spinner" aria-hidden="true" />
    <span v-else class="icon" aria-hidden="true">{{ preset.icon }}</span>
    <p class="title">{{ heading }}</p>
    <p v-if="description" class="desc">{{ description }}</p>
    <div v-if="$slots.default" class="actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.state-view {
  display: grid;
  justify-items: center;
  align-content: center;
  gap: 10px;
  padding: 40px 24px;
  text-align: center;
  color: var(--text-faint);
  min-height: 180px;
}
.state-view.compact {
  padding: 18px 16px;
  min-height: 0;
  gap: 7px;
}
.icon {
  font-size: 28px;
  line-height: 1;
  opacity: 0.85;
}
.compact .icon {
  font-size: 18px;
}
.title {
  margin: 0;
  color: var(--text-dim);
  font-weight: 700;
  font-size: var(--text-md);
}
.compact .title {
  font-size: var(--text-sm);
}
.desc {
  margin: 0;
  max-width: 56ch;
  color: var(--text-faint);
  font-size: var(--text-sm);
  line-height: var(--leading-snug);
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 4px;
}
/* Tones colour the heading + icon. */
.info .icon,
.info .title {
  color: var(--blue);
}
.warn .icon,
.warn .title {
  color: var(--amber);
}
.error .icon,
.error .title {
  color: var(--red);
}
.success .icon,
.success .title {
  color: var(--green);
}
.spinner {
  width: 22px;
  height: 22px;
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
