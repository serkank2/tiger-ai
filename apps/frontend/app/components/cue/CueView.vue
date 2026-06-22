<script setup lang="ts">
import { onMounted, ref } from 'vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import EmptyState from '~/components/ui/EmptyState.vue';
import Spinner from '~/components/ui/Spinner.vue';
import CueSubscriptionCard from '~/components/cue/CueSubscriptionCard.vue';
import CueSubscriptionEditor from '~/components/cue/CueSubscriptionEditor.vue';
import { useCueStore } from '~/stores/cue';
import { useApi } from '~/composables/useApi';
import { useDialog } from '~/composables/useDialog';
import { useT } from '~/composables/useT';
import { errText } from '~/lib/apiError';
import type { CueSubscriptionInput } from '~/types';

const cue = useCueStore();
const api = useApi();
const dialog = useDialog();
const { t } = useT();

const editorOpen = ref(false);
const editing = ref<CueSubscriptionInput | null>(null);
const editorError = ref<string | null>(null);

onMounted(() => {
  void cue.load();
});

async function onReload(): Promise<void> {
  try {
    await cue.reload();
  } catch {
    /* error surfaced via store.loadError */
  }
}

async function onTrigger(id: string): Promise<void> {
  try {
    await cue.trigger(id);
  } catch {
    /* error surfaced via store.loadError */
  }
}

function onNew(): void {
  editing.value = null;
  editorError.value = null;
  editorOpen.value = true;
}

async function onEdit(id: string): Promise<void> {
  editorError.value = null;
  try {
    const { subscription } = await api.getCueSubscription(id);
    editing.value = subscription;
    editorOpen.value = true;
  } catch (e) {
    cue.loadError = errText(e);
  }
}

async function onSave(sub: CueSubscriptionInput, originalId: string | null): Promise<void> {
  editorError.value = null;
  try {
    if (originalId) await cue.update(originalId, sub);
    else await cue.create(sub);
    editorOpen.value = false;
  } catch (e) {
    editorError.value = errText(e);
  }
}

async function onRemove(id: string): Promise<void> {
  const ok = await dialog.confirm({
    title: t('cue.delete.title'),
    message: t('cue.delete.message', { id }),
    confirmText: t('common.delete'),
    danger: true,
  });
  if (!ok) return;
  try {
    await cue.remove(id);
  } catch {
    /* error surfaced via store.loadError */
  }
}
</script>

<template>
  <section class="cue">
    <header class="bar">
      <div class="heading">
        <h1>{{ t('cue.title') }}</h1>
        <p class="sub">{{ t('cue.subtitle') }}</p>
      </div>
      <div class="actions">
        <span v-if="cue.running" class="status on">? {{ t('cue.status.running') }}</span>
        <span v-else-if="cue.loaded && !cue.disabled" class="status off">? {{ t('cue.status.stopped') }}</span>
        <BaseButton
          :loading="cue.isBusy('reload')"
          :disabled="cue.disabled"
          variant="ghost"
          @click="onReload"
        >
          {{ t('cue.actions.reloadConfig') }}
        </BaseButton>
        <BaseButton :disabled="cue.disabled" @click="onNew">{{ t('cue.actions.newSubscription') }}</BaseButton>
      </div>
    </header>

    <div v-if="!cue.loaded" class="loading">
      <Spinner :label="t('cue.states.loading')" />
    </div>

    <EmptyState
      v-else-if="cue.disabled"
      :title="t('cue.states.disabledTitle')"
      :description="t('cue.states.disabledDescription')"
    />

    <EmptyState
      v-else-if="cue.loadError"
      :title="t('cue.states.loadErrorTitle')"
      :description="cue.loadError"
      tone="danger"
    >
      <template #actions>
        <BaseButton @click="onReload">{{ t('cue.actions.retry') }}</BaseButton>
      </template>
    </EmptyState>

    <template v-else>
      <p class="ctx">
        <span v-if="cue.workspace">{{ t('cue.context.workspace') }}: <code>{{ cue.workspace }}</code></span>
        <span v-else>{{ t('cue.context.noWorkspace') }}</span>
        <span v-if="cue.configPath"> ? {{ t('cue.context.config') }}: <code>{{ cue.configPath }}</code></span>
      </p>

      <EmptyState
        v-if="cue.subscriptions.length === 0"
        :title="t('cue.states.emptyTitle')"
        :description="t('cue.states.emptyDescription')"
      >
        <template #actions>
          <BaseButton @click="onNew">{{ t('cue.actions.newSubscription') }}</BaseButton>
        </template>
      </EmptyState>

      <div v-else class="grid">
        <CueSubscriptionCard
          v-for="sub in cue.subscriptions"
          :key="sub.id"
          :sub="sub"
          :busy="cue.isBusy(`trigger:${sub.id}`)"
          :deleting="cue.isBusy(`delete:${sub.id}`)"
          @trigger="onTrigger"
          @edit="onEdit"
          @remove="onRemove"
        />
      </div>
    </template>

    <CueSubscriptionEditor
      :open="editorOpen"
      :initial="editing"
      :saving="cue.isBusy('save')"
      :error="editorError"
      @close="editorOpen = false"
      @save="onSave"
    />
  </section>
</template>

<style scoped>
.cue {
  display: grid;
  gap: 14px;
  padding: 18px 20px;
  min-height: 0;
  overflow-y: auto;
}
.bar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.heading h1 {
  margin: 0;
  font-size: var(--text-lg);
}
.sub {
  margin: 4px 0 0;
  color: var(--text-faint);
  font-size: 13px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.status {
  font-size: 12px;
  font-weight: 600;
}
.status.on {
  color: var(--green);
}
.status.off {
  color: var(--text-faint);
}
.ctx {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
}
.ctx code {
  color: var(--text-dim);
}
.grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
}
.grid > * {
  min-width: 0;
}
.loading {
  display: grid;
  place-items: center;
  padding: 40px;
}
@media (max-width: 520px) {
  .bar {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
