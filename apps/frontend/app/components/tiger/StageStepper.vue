<script setup lang="ts">
import type { TigerStageId, TigerStageState } from '~/types';
import { TIGER_STAGES } from '~/lib/tigerStages';
import { useT } from '~/composables/useT';

const { t } = useT();

defineProps<{ stages: Record<TigerStageId, TigerStageState> | null }>();
const selected = defineModel<TigerStageId>({ required: true });

const tabRefs = ref<HTMLButtonElement[]>([]);

// Roving-tabindex arrow navigation across the stage tabs: move selection and focus
// in lockstep so the active stage is the single Tab stop.
function onKeydown(e: KeyboardEvent, index: number) {
  let next = index;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % TIGER_STAGES.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + TIGER_STAGES.length) % TIGER_STAGES.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = TIGER_STAGES.length - 1;
  else return;
  e.preventDefault();
  selected.value = TIGER_STAGES[next]!.id;
  void nextTick(() => tabRefs.value[next]?.focus());
}
</script>

<template>
  <nav class="stepper" role="tablist" :aria-label="t('tiger.stageStepper.ariaLabel')">
    <button
      v-for="(s, i) in TIGER_STAGES"
      :key="s.id"
      ref="tabRefs"
      type="button"
      class="step"
      role="tab"
      :aria-selected="selected === s.id"
      :tabindex="selected === s.id ? 0 : -1"
      :class="[{ on: selected === s.id }, `st-${stages?.[s.id]?.status ?? 'not_started'}`]"
      @click="selected = s.id"
      @keydown="onKeydown($event, i)"
    >
      <span class="num">{{ s.number }}</span>
      <span class="title">{{ t('tiger.stages.' + s.id + '.title') }}</span>
      <span v-if="s.optional" class="opt" :title="t('tiger.stageStepper.optionalTitle')">{{
        t('tiger.stageStepper.opt')
      }}</span>
      <span class="dot" aria-hidden="true" />
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
@media (prefers-reduced-motion: reduce) {
  .st-running .dot {
    animation: none;
  }
}
</style>
