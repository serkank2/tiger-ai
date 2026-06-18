<script setup lang="ts">
import { computed, ref } from 'vue';
import { useTeamStore } from '~/stores/team';
import BaseButton from '../ui/BaseButton.vue';

const team = useTeamStore();

const text = ref('');
const runId = computed(() => team.activeRunId);
const busy = computed(() => (runId.value ? team.isBusy(`steer:${runId.value}`) : false));
const canSend = computed(() => text.value.trim().length > 0 && !busy.value);

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
    <textarea
      v-model="text"
      class="input"
      rows="1"
      placeholder="Steer the team — e.g. focus on the payment flow, prioritize tests, ship the MVP first…"
      @keydown="onKeydown"
    />
    <BaseButton variant="primary" size="md" :loading="busy" :disabled="!canSend" @click="send">Steer</BaseButton>
  </div>
</template>

<style scoped>
.steer {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border);
  background: var(--bg-elev);
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
