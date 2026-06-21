<script setup lang="ts">
import { onMounted } from 'vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import EmptyState from '~/components/ui/EmptyState.vue';
import Spinner from '~/components/ui/Spinner.vue';
import CueSubscriptionCard from '~/components/cue/CueSubscriptionCard.vue';
import { useCueStore } from '~/stores/cue';

const cue = useCueStore();

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
</script>

<template>
  <section class="cue">
    <header class="bar">
      <div class="heading">
        <h1>Cue</h1>
        <p class="sub">Event-driven orchestration — wake agents into self-running pipelines.</p>
      </div>
      <div class="actions">
        <span v-if="cue.running" class="status on">● running</span>
        <span v-else-if="cue.loaded && !cue.disabled" class="status off">● stopped</span>
        <BaseButton
          :loading="cue.isBusy('reload')"
          :disabled="cue.disabled"
          @click="onReload"
        >
          Reload config
        </BaseButton>
      </div>
    </header>

    <div v-if="!cue.loaded" class="loading">
      <Spinner label="Loading Cue…" />
    </div>

    <EmptyState
      v-else-if="cue.disabled"
      title="Cue is disabled"
      description="The Cue engine is off. Start the backend with KAPLAN_CUE_ENABLED=1 to load .kaplan/cue.json and enable event-driven pipelines."
    />

    <EmptyState
      v-else-if="cue.loadError"
      title="Could not load Cue"
      :description="cue.loadError"
      tone="danger"
    >
      <template #actions>
        <BaseButton @click="onReload">Retry</BaseButton>
      </template>
    </EmptyState>

    <template v-else>
      <p class="ctx">
        <span v-if="cue.workspace">Workspace: <code>{{ cue.workspace }}</code></span>
        <span v-else>No active workspace.</span>
        <span v-if="cue.configPath"> · Config: <code>{{ cue.configPath }}</code></span>
      </p>

      <EmptyState
        v-if="cue.subscriptions.length === 0"
        title="No subscriptions"
        description="Define subscriptions in .kaplan/cue.json in your workspace, then Reload config."
      />

      <div v-else class="grid">
        <CueSubscriptionCard
          v-for="sub in cue.subscriptions"
          :key="sub.id"
          :sub="sub"
          :busy="cue.isBusy(`trigger:${sub.id}`)"
          @trigger="onTrigger"
        />
      </div>
    </template>
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
  color: var(--green, #3fb950);
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
