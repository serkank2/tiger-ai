<script setup lang="ts">
import { computed, ref } from 'vue';
import { useTeamStore } from '~/stores/team';
import { useT } from '~/composables/useT';
import BaseButton from '../ui/BaseButton.vue';

const team = useTeamStore();
const { t } = useT();

const text = ref('');
const runId = computed(() => team.activeRunId);
const busy = computed(() => (runId.value ? team.isBusy(`steer:${runId.value}`) : false));
const canSend = computed(() => text.value.trim().length > 0 && !busy.value);

// The Lead owns the flow: every message routes to the Lead, which decomposes the work and
// assigns the agents. Surface the Lead's pending/waiting state from the fields the run state
// already carries (pending prompt count, status, and the run's human status message).
const pendingCount = computed(() => team.directives.length);
const waiting = computed(() => team.state?.status === 'blocked');
const hint = computed(() => {
  if (waiting.value) {
    return (
      team.state?.message ||
      t('team.steer.waitingDefault')
    );
  }
  if (pendingCount.value > 0) {
    return t(pendingCount.value === 1 ? 'team.steer.queuedForLeadOne' : 'team.steer.queuedForLeadMany', { n: pendingCount.value });
  }
  return '';
});
const sendLabel = computed(() => (waiting.value ? t('team.steer.replyToLead') : t('team.steer.sendToLead')));

async function send() {
  if (!canSend.value) return;
  const body = text.value.trim();
  try {
    await team.steer({ body });
    text.value = '';
  } catch {
    /* store surfaces the error via notices */
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}
</script>

<template>
  <div class="steer">
    <p v-if="hint" class="hint" :class="{ waiting }">{{ hint }}</p>
    <div class="row">
      <textarea
        v-model="text"
        class="input"
        rows="1"
        :placeholder="t('team.steer.placeholder')"
        :aria-label="t('team.steer.ariaLabel')"
        @keydown="onKeydown"
      />
      <BaseButton variant="primary" size="md" :loading="busy" :disabled="!canSend" @click="send">{{ sendLabel }}</BaseButton>
    </div>
  </div>
</template>

<style scoped>
.steer {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border);
  background: var(--bg-elev);
}
.hint {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.hint.waiting {
  color: var(--amber);
}
.row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
}
.input {
  flex: 1;
  resize: none;
  max-height: 140px;
  min-height: 38px;
  font-family: inherit;
  font-size: var(--text-sm);
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  line-height: var(--leading-normal);
}
</style>
