<script setup lang="ts">
import { computed } from 'vue';
import { useConnectionStore } from '~/stores/connection';
import { useLimitsStore } from '~/stores/limits';
import { useT } from '~/composables/useT';
import { percentText } from '~/lib/limits';

const emit = defineEmits<{ open: [] }>();

const conn = useConnectionStore();
const limits = useLimitsStore();
const { t } = useT();

const chipState = computed(() => {
  if (limits.loading && !limits.loaded) return 'loading';
  if (conn.status === 'disconnected') return 'disconnected';
  if (limits.hasErrors) return 'error';
  if (!limits.hasData) return 'empty';
  if (limits.decision?.action === 'block') return 'blocked';
  if (limits.stale) return 'stale';
  return limits.severity;
});

const label = computed(() => {
  if (chipState.value === 'loading') return t('limits.chip.label');
  if (chipState.value === 'disconnected') return t('limits.chip.offline');
  if (chipState.value === 'error') return t('limits.chip.error');
  if (chipState.value === 'empty') return t('limits.chip.empty');
  if (chipState.value === 'blocked') return t('limits.chip.blocked');
  if (chipState.value === 'stale') return t('limits.chip.stale');
  return t('limits.chip.label');
});

const title = computed(() => {
  const decision = limits.decision?.reason;
  if (decision) return decision;
  if (limits.loadError) return limits.loadError;
  if (limits.refreshError) return limits.refreshError;
  return t('limits.chip.openTitle');
});

const percent = computed(() => percentText(limits.maxPercentUsed));
const showPercent = computed(() => limits.maxPercentUsed !== null && chipState.value !== 'empty');
</script>

<template>
  <button
    type="button"
    class="limit-chip"
    :class="`state-${chipState}`"
    :title="title"
    :aria-label="t('limits.chip.openAria')"
    @click="emit('open')"
  >
    <span class="dot" aria-hidden="true" />
    <span class="label">{{ label }}</span>
    <span v-if="showPercent" class="pct">{{ percent }}</span>
  </button>
</template>

<style scoped>
.limit-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  min-width: 0;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-elev-2);
  color: var(--text);
  font-size: 12px;
  font-weight: 700;
  flex: none;
}
.limit-chip:hover {
  border-color: var(--accent);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--slate);
  flex: none;
}
.label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pct {
  font-family: var(--font-mono);
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
  line-height: 1.4;
}
.state-ok .dot {
  background: var(--green);
}
.state-amber .dot,
.state-stale .dot,
.state-loading .dot {
  background: var(--amber);
}
.state-red .dot,
.state-blocked .dot,
.state-error .dot,
.state-disconnected .dot {
  background: var(--red);
}
.state-amber .pct,
.state-stale .pct {
  color: var(--amber);
}
.state-red .pct,
.state-blocked .pct,
.state-error .pct {
  color: var(--red);
}

@media (max-width: 980px) {
  .label {
    max-width: 72px;
  }
}
</style>
