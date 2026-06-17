<script setup lang="ts">
import type { TigerStageId, TigerStageState } from '~/types';
import { TIGER_STAGES } from '~/lib/tigerStages';

defineProps<{ stages: Record<TigerStageId, TigerStageState> | null }>();
const selected = defineModel<TigerStageId>({ required: true });
</script>

<template>
  <nav class="stepper">
    <button
      v-for="s in TIGER_STAGES"
      :key="s.id"
      type="button"
      class="step"
      :class="[{ on: selected === s.id }, `st-${stages?.[s.id]?.status ?? 'not_started'}`]"
      @click="selected = s.id"
    >
      <span class="num">{{ s.number }}</span>
      <span class="title">{{ s.title }}</span>
      <span v-if="s.optional" class="opt" title="Optional stage">opt</span>
      <span class="dot" />
    </button>
  </nav>
</template>

<style scoped>
.stepper {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.step {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
}
.step:hover {
  border-color: var(--accent);
  color: var(--text);
}
.step.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.num {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  opacity: 0.8;
}
.title {
  font-size: 13px;
  font-weight: 600;
}
.opt {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 5px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--slate);
}
.st-running .dot {
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
  animation: blink 1s infinite;
}
.st-completed .dot {
  background: var(--green);
}
.st-failed .dot {
  background: var(--red);
}
.st-stopped .dot {
  background: var(--amber);
}
@keyframes blink {
  50% {
    opacity: 0.3;
  }
}
</style>
