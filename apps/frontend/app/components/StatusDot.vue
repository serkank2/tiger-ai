<script setup lang="ts">
import type { TerminalRunState } from '~/types';

const props = defineProps<{ state: TerminalRunState; label?: boolean }>();

const META: Record<TerminalRunState, { cls: string; text: string }> = {
  starting: { cls: 'amber', text: 'Starting' },
  running: { cls: 'green', text: 'Running' },
  exited: { cls: 'slate', text: 'Exited' },
  failed: { cls: 'red', text: 'Failed' },
  stopped: { cls: 'slate', text: 'Stopped' },
};
const meta = computed(() => META[props.state]);
</script>

<template>
  <span class="status" :class="meta.cls" :title="meta.text">
    <span class="dot" />
    <span v-if="label" class="txt">{{ meta.text }}</span>
  </span>
</template>

<style scoped>
.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--slate);
  flex: none;
}
.green .dot {
  background: var(--green);
  box-shadow: 0 0 8px var(--green);
}
.amber .dot {
  background: var(--amber);
  box-shadow: 0 0 8px var(--amber);
  animation: pulse 1.2s ease-in-out infinite;
}
.red .dot {
  background: var(--red);
  box-shadow: 0 0 8px var(--red);
}
.green .txt {
  color: var(--green);
}
.amber .txt {
  color: var(--amber);
}
.red .txt {
  color: var(--red);
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
</style>
