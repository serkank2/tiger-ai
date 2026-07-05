<script setup lang="ts">
// Work-item drill-down: the brief the agent got, what happened across attempts,
// and this item's own slice of the event feed — everything the engine records.
import { computed } from 'vue';
import BaseModal from '~/components/ui/BaseModal.vue';
import { useT } from '~/composables/useT';
import type { RunEventDto, RunWorkItem } from '~/types';

const props = defineProps<{ item: RunWorkItem; events: RunEventDto[] }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useT();

const itemEvents = computed(() => props.events.filter((event) => event.itemId === props.item.id));

function eventLine(event: RunEventDto): string {
  if (event.type === 'item-status') return `→ ${event.itemStatus}${event.text ? ` — ${event.text}` : ''}`;
  if (event.type === 'agent') {
    const agent = event.agent;
    if (!agent) return '';
    if (agent.type === 'tool-use') return `⚙ ${agent.tool?.name ?? 'tool'} ${agent.tool?.detail ?? ''}`;
    if (agent.type === 'result') return '✔ turn result received';
    return agent.text ?? agent.type;
  }
  return event.text ?? '';
}

function formatCost(): string {
  const cost = props.item.usage?.costUsd;
  return cost !== undefined && cost > 0 ? `$${cost.toFixed(4)}` : '—';
}

function formatTokens(): string {
  const usage = props.item.usage;
  if (!usage) return '—';
  const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return total > 0 ? total.toLocaleString() : '—';
}
</script>

<template>
  <BaseModal :title="`${item.id} — ${item.title}`" size="lg" data-testid="run-item-modal" @close="emit('close')">
    <div class="detail">
      <dl class="facts">
        <div>
          <dt>{{ t('runs.detail.status') }}</dt>
          <dd>
            <span class="badge" :data-status="item.status">{{ t(`runs.itemStatus.${item.status}`) }}</span>
          </dd>
        </div>
        <div>
          <dt>{{ t('runs.detail.attempts') }}</dt>
          <dd>{{ item.attempts }}</dd>
        </div>
        <div>
          <dt>{{ t('runs.detail.agent') }}</dt>
          <dd>{{ item.agentKey }} ({{ item.kind }})</dd>
        </div>
        <div>
          <dt>{{ t('runs.usage') }}</dt>
          <dd>{{ formatTokens() }} {{ t('runs.tokens') }} · {{ formatCost() }}</dd>
        </div>
        <div v-if="item.dependsOn.length">
          <dt>{{ t('runs.detail.dependsOn') }}</dt>
          <dd>{{ item.dependsOn.join(', ') }}</dd>
        </div>
        <div v-if="item.fixOf">
          <dt>{{ t('runs.detail.fixOf') }}</dt>
          <dd>{{ item.fixOf }}</dd>
        </div>
      </dl>

      <section>
        <h3>{{ t('runs.detail.brief') }}</h3>
        <pre class="brief">{{ item.description }}</pre>
      </section>

      <section v-if="item.acceptanceCriteria?.length">
        <h3>{{ t('runs.detail.acceptance') }}</h3>
        <ul class="criteria">
          <li v-for="criterion in item.acceptanceCriteria" :key="criterion">{{ criterion }}</li>
        </ul>
      </section>

      <section v-if="item.resultSummary">
        <h3>{{ t('runs.detail.result') }}</h3>
        <p class="result">{{ item.resultSummary }}</p>
      </section>

      <section v-if="item.error">
        <h3>{{ t('runs.detail.error') }}</h3>
        <p class="error">{{ item.error }}</p>
      </section>

      <section v-if="itemEvents.length">
        <h3>{{ t('runs.detail.events') }} ({{ itemEvents.length }})</h3>
        <ul class="events">
          <li v-for="event in itemEvents" :key="event.seq">
            <span class="seq">#{{ event.seq }}</span>
            <span>{{ eventLine(event) }}</span>
          </li>
        </ul>
      </section>
    </div>
  </BaseModal>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 13px;
}
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
  margin: 0;
}
.facts dt {
  color: var(--text-dim);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.facts dd {
  margin: 2px 0 0;
}
h3 {
  margin: 0 0 6px;
  font-size: 13px;
}
.brief {
  margin: 0;
  white-space: pre-wrap;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
  padding: 8px;
  max-height: 30vh;
  overflow: auto;
  font-size: 12px;
}
.criteria {
  margin: 0;
  padding-left: 18px;
}
.result {
  margin: 0;
}
.error {
  margin: 0;
  color: var(--danger, #f87171);
}
.events {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 30vh;
  overflow: auto;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.events .seq {
  color: var(--text-dim);
  margin-right: 8px;
}
.badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-dim);
  text-transform: uppercase;
}
.badge[data-status='done'] {
  color: var(--ok, #4ade80);
  border-color: currentColor;
}
.badge[data-status='running'],
.badge[data-status='verifying'] {
  color: var(--accent, #60a5fa);
  border-color: currentColor;
}
.badge[data-status='blocked'] {
  color: var(--danger, #f87171);
  border-color: currentColor;
}
</style>
