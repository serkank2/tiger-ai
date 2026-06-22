<script setup lang="ts">
import { computed } from 'vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import { useT } from '~/composables/useT';
import type { CueSubscriptionStatus } from '~/types';

const props = defineProps<{ sub: CueSubscriptionStatus; busy?: boolean; deleting?: boolean }>();
const emit = defineEmits<{ trigger: [id: string]; edit: [id: string]; remove: [id: string] }>();
const { t } = useT();

const eventLabel = computed<Record<CueSubscriptionStatus['event'], string>>(() => ({
  'file.changed': t('cue.subscription.events.fileChanged'),
  'time.scheduled': t('cue.subscription.events.scheduled'),
  'time.once': t('cue.subscription.events.once'),
  'agent.completed': t('cue.subscription.events.agentCompleted'),
  'cli.trigger': t('cue.subscription.events.manual'),
}));

const isManual = computed(() => props.sub.event === 'cli.trigger');
const lastFired = computed(() =>
  props.sub.lastFiredAt ? new Date(props.sub.lastFiredAt).toLocaleString() : t('cue.subscription.never'),
);
</script>

<template>
  <div class="card" :class="{ disabled: !sub.enabled }">
    <div class="head">
      <div class="title">
        <span class="name">{{ sub.name ?? sub.id }}</span>
        <span class="badge event">{{ eventLabel[sub.event] }}</span>
        <span class="badge target">→ {{ sub.target }}</span>
        <span v-if="!sub.enabled" class="badge off">{{ t('cue.subscription.disabled') }}</span>
      </div>
      <div class="card-actions">
        <BaseButton
          v-if="isManual"
          size="sm"
          :loading="busy"
          :disabled="!sub.enabled"
          @click="emit('trigger', sub.id)"
        >
          {{ t('cue.subscription.trigger') }}
        </BaseButton>
        <BaseButton size="sm" variant="ghost" @click="emit('edit', sub.id)">{{ t('common.edit') }}</BaseButton>
        <BaseButton size="sm" variant="ghost" :loading="deleting" @click="emit('remove', sub.id)">{{ t('common.delete') }}</BaseButton>
      </div>
    </div>

    <dl class="meta">
      <div><dt>{{ t('cue.subscription.lastFired') }}</dt><dd>{{ lastFired }}</dd></div>
      <div><dt>{{ t('cue.subscription.fires') }}</dt><dd>{{ sub.fireCount }}</dd></div>
      <div v-if="sub.pendingSources?.length">
        <dt>{{ t('cue.subscription.waitingOn') }}</dt>
        <dd>{{ sub.pendingSources.join(', ') }}</dd>
      </div>
    </dl>

    <p v-if="sub.lastError" class="err" role="alert">⚠ {{ sub.lastError }}</p>
  </div>
</template>

<style scoped>
.card {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
  padding: 12px 14px;
  display: grid;
  gap: 8px;
}
.card.disabled {
  opacity: 0.6;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.name {
  font-weight: 700;
  color: var(--text);
}
.badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-dim);
  white-space: nowrap;
}
.badge.event {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}
.badge.off {
  color: var(--text-faint);
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  margin: 0;
}
.meta div {
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.meta dt {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
}
.meta dd {
  margin: 0;
  font-size: 12px;
  color: var(--text-dim);
  font-weight: 600;
}
.err {
  margin: 0;
  font-size: 12px;
  color: var(--red);
}
</style>
