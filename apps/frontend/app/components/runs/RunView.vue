<script setup lang="ts">
// v2 Runs screen — the WorkGraph engine's control panel (docs/REDESIGN.md §5).
// One screen answers: what is being worked on, what is blocked on what, what
// did each turn cost — and, review-first like the best competitors: WHAT
// CHANGED (diff panel). REST for control; `run.state`/`run.event` WS frames
// drive everything live — no polling.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import BaseField from '~/components/ui/BaseField.vue';
import BaseInput from '~/components/ui/BaseInput.vue';
import BaseModal from '~/components/ui/BaseModal.vue';
import BaseSelect from '~/components/ui/BaseSelect.vue';
import EmptyState from '~/components/ui/EmptyState.vue';
import Spinner from '~/components/ui/Spinner.vue';
import FolderPicker from '~/components/FolderPicker.vue';
import RunChangesPanel from '~/components/runs/RunChangesPanel.vue';
import RunHistoryPanel from '~/components/runs/RunHistoryPanel.vue';
import RunItemModal from '~/components/runs/RunItemModal.vue';
import RunTerminalsPanel from '~/components/runs/RunTerminalsPanel.vue';
import { useRunsStore } from '~/stores/runs';
import { useApi } from '~/composables/useApi';
import { useDialog } from '~/composables/useDialog';
import { useT } from '~/composables/useT';
import type { ProvidersConfig, RunCouncilMember, RunEventDto, RunWorkItem } from '~/types';

const runs = useRunsStore();
const api = useApi();
const dialog = useDialog();
const { t } = useT();

const LAST_WORKSPACE_KEY = 'kaplan.runs.lastWorkspace';

type Provider = 'claude' | 'codex' | 'antigravity';
const PROVIDERS: Provider[] = ['claude', 'codex', 'antigravity'];

const goal = ref('');
const workspace = ref('');
const provider = ref<Provider>('claude');
const builderModel = ref('');
const builderEffort = ref('');
const reviewPolicy = ref<'final' | 'per-task' | 'none'>('final');
const verifyPolicy = ref<'per-build' | 'final' | 'both' | 'none'>('both');
const importance = ref<'low' | 'normal' | 'high' | 'critical'>('normal');
// Explicit council roster: how many agents start from each provider, and with
// which model/effort. Any selection overrides the importance preset (counts as
// strings — HTML select values are strings).
const councilCounts = ref<Record<Provider, string>>({ claude: '0', codex: '0', antigravity: '0' });
const councilModels = ref<Record<Provider, string>>({ claude: '', codex: '', antigravity: '' });
const councilEfforts = ref<Record<Provider, string>>({ claude: '', codex: '', antigravity: '' });
const providersCfg = ref<ProvidersConfig | null>(null);
const steering = ref('');
const verboseFeed = ref(false);
const pickerOpen = ref(false);
const selectedItemId = ref<string | null>(null);
const showChanges = ref(false);
const showHistory = ref(false);
const showTerminals = ref(true);
const feedEl = ref<HTMLElement | null>(null);

let unbind: (() => void) | null = null;
onMounted(() => {
  unbind = runs.bindSocket();
  void runs.load();
  // Model lists for the builder/council selects; selects fall back to
  // "provider default" when the config is unavailable.
  void api
    .getProvidersConfig()
    .then(({ config }) => {
      providersCfg.value = config;
    })
    .catch(() => {});
  try {
    workspace.value = localStorage.getItem(LAST_WORKSPACE_KEY) ?? '';
  } catch {
    /* storage unavailable */
  }
});
onBeforeUnmount(() => {
  unbind?.();
});

// Model/effort lists are provider-specific — a switched builder keeps no stale pin.
watch(provider, () => {
  builderModel.value = '';
  builderEffort.value = '';
});

const showCreate = computed(
  () => runs.loaded && (!runs.run || ['completed', 'failed', 'stopped'].includes(runs.run.status)),
);

const selectedItem = computed<RunWorkItem | null>(
  () => runs.items.find((item) => item.id === selectedItemId.value) ?? null,
);

// Brand names stay literal; policy labels are localized.
const providerOptions = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'antigravity', label: 'Antigravity' },
];
const reviewOptions = computed(() => [
  { value: 'final', label: t('runs.options.reviewFinal') },
  { value: 'per-task', label: t('runs.options.reviewPerTask') },
  { value: 'none', label: t('runs.options.reviewNone') },
]);
const verifyOptions = computed(() => [
  { value: 'both', label: t('runs.options.verifyBoth') },
  { value: 'per-build', label: t('runs.options.verifyPerBuild') },
  { value: 'final', label: t('runs.options.verifyFinal') },
  { value: 'none', label: t('runs.options.verifyNone') },
]);
// Importance sizes the COUNCIL: independent plan candidates + review lenses.
// The write path stays single-agent regardless (docs/REDESIGN.md §3).
const importanceOptions = computed(() => [
  { value: 'low', label: t('runs.importance.low') },
  { value: 'normal', label: t('runs.importance.normal') },
  { value: 'high', label: t('runs.importance.high') },
  { value: 'critical', label: t('runs.importance.critical') },
]);
const countOptions = ['0', '1', '2', '3', '4', '5', '6'].map((value) => ({ value, label: value }));

function providerLabel(p: Provider): string {
  return providerOptions.find((option) => option.value === p)?.label ?? p;
}

function modelOptions(p: Provider): Array<{ value: string; label: string }> {
  const models = providersCfg.value?.[p]?.models ?? [];
  return [
    { value: '', label: t('runs.council.defaultModel') },
    ...models.map((model) => ({ value: model, label: model })),
  ];
}

function effortOptions(p: Provider): Array<{ value: string; label: string }> {
  const efforts = (providersCfg.value?.[p]?.efforts ?? []).filter((effort) => effort !== '');
  return [
    { value: '', label: t('runs.council.defaultModel') },
    ...efforts.map((effort) => ({ value: effort, label: effort })),
  ];
}

const councilMembers = computed<RunCouncilMember[]>(() =>
  PROVIDERS.flatMap((p) => {
    const count = Number(councilCounts.value[p]);
    if (!Number.isFinite(count) || count < 1) return [];
    return [
      {
        provider: p,
        count,
        model: councilModels.value[p] || undefined,
        effort: councilEfforts.value[p] || undefined,
      },
    ];
  }),
);
const councilTotal = computed(() => councilMembers.value.reduce((total, member) => total + member.count, 0));

async function onCreate(): Promise<void> {
  if (!goal.value.trim() || !workspace.value.trim()) return;
  try {
    localStorage.setItem(LAST_WORKSPACE_KEY, workspace.value.trim());
  } catch {
    /* storage unavailable */
  }
  try {
    await runs.create({
      workspace: workspace.value.trim(),
      goal: goal.value.trim(),
      config: {
        builder: {
          provider: provider.value,
          model: builderModel.value || undefined,
          effort: builderEffort.value || undefined,
        },
        reviewPolicy: reviewPolicy.value,
        verifyPolicy: verifyPolicy.value,
        importance: importance.value,
        ...(councilMembers.value.length ? { council: { members: councilMembers.value } } : {}),
      },
    });
    await runs.start();
    goal.value = '';
    showChanges.value = false;
    showTerminals.value = true;
  } catch {
    /* surfaced via runs.loadError + toast */
  }
}

async function onStop(): Promise<void> {
  const confirmed = await dialog.confirm({
    title: t('runs.confirmStop.title'),
    message: t('runs.confirmStop.message'),
    confirmText: t('runs.stop'),
    danger: true,
  });
  if (!confirmed) return;
  try {
    await runs.stop();
  } catch {
    /* surfaced via runs.loadError + toast */
  }
}

async function onSteer(interrupt = false): Promise<void> {
  const body = steering.value.trim();
  if (!body) return;
  try {
    await runs.steer(body, interrupt);
    steering.value = '';
  } catch {
    /* surfaced via runs.loadError + toast */
  }
}

function onToggleChanges(): void {
  showChanges.value = !showChanges.value;
  if (showChanges.value) void runs.loadChanges();
}

function onToggleHistory(): void {
  showHistory.value = !showHistory.value;
  if (showHistory.value) void runs.loadHistory();
}

// The diff is the review unit: fetch it automatically the moment a run settles.
watch(
  () => runs.run?.status,
  (status, previous) => {
    if (status && previous === 'running' && ['completed', 'blocked', 'failed', 'stopped'].includes(status)) {
      showChanges.value = true;
      void runs.loadChanges();
      void runs.loadHistory();
    }
  },
);

// Keep the live feed pinned to the newest line unless the user scrolled up.
watch(
  () => runs.events.length,
  async () => {
    const el = feedEl.value;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (!nearBottom) return;
    await nextTick();
    el.scrollTop = el.scrollHeight;
  },
);

function itemStatusLabel(item: RunWorkItem): string {
  return t(`runs.itemStatus.${item.status}`);
}

const KIND_ICONS: Record<RunWorkItem['kind'], string> = { plan: '🧭', build: '🔨', review: '🔍' };

function eventLine(event: RunEventDto): string {
  switch (event.type) {
    case 'run-status':
      return `run → ${event.status}${event.text ? ` — ${event.text}` : ''}`;
    case 'item-status':
      return `${event.itemId} → ${event.itemStatus}${event.text ? ` — ${event.text}` : ''}`;
    case 'agent': {
      const agent = event.agent;
      if (!agent) return event.itemId ?? '';
      if (agent.type === 'tool-use')
        return `${event.itemId} ⚙ ${agent.tool?.name ?? 'tool'} ${agent.tool?.detail ?? ''}`;
      if (agent.type === 'result') return `${event.itemId} ✔ turn result received`;
      return `${event.itemId} ${agent.text ?? agent.type}`;
    }
    case 'verification':
      return `check ${event.verification?.id}: ${event.verification?.outcome} (exit ${event.verification?.exitCode ?? '—'})`;
    case 'steering':
      return `steering: ${event.text ?? ''}`;
    default:
      return event.text ?? '';
  }
}

// Verbose mode = watch EVERYTHING the agent emits (stderr/raw/usage included) —
// the full stream also renders per-agent in the terminals panel.
const eventFeed = computed(() =>
  verboseFeed.value
    ? runs.events
    : runs.events.filter(
        (event) =>
          !(
            event.type === 'agent' &&
            (event.agent?.type === 'stderr' || event.agent?.type === 'usage' || event.agent?.type === 'raw')
          ),
      ),
);

function formatTokens(): string {
  const usage = runs.run?.usage;
  if (!usage) return '—';
  const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return total > 0 ? total.toLocaleString() : '—';
}

function formatCost(): string {
  const cost = runs.run?.usage.costUsd;
  return cost !== undefined && cost > 0 ? `$${cost.toFixed(4)}` : '—';
}
</script>

<template>
  <section class="runs" :aria-label="t('runs.title')">
    <header class="runs-header">
      <div>
        <h1>{{ t('runs.title') }}</h1>
        <p class="subtitle">{{ t('runs.subtitle') }}</p>
      </div>
      <div class="controls">
        <BaseButton size="sm" variant="ghost" data-testid="run-toggle-history" @click="onToggleHistory">
          {{ t('runs.history.title') }}
        </BaseButton>
        <template v-if="runs.run">
          <BaseButton
            size="sm"
            variant="ghost"
            data-testid="run-toggle-terminals"
            @click="showTerminals = !showTerminals"
          >
            {{ t('runs.terminals.title') }}
          </BaseButton>
          <BaseButton size="sm" variant="ghost" data-testid="run-toggle-changes" @click="onToggleChanges">
            {{ t('runs.changes.title') }}
          </BaseButton>
          <span
            v-if="runs.run.importance !== 'normal'"
            class="status importance"
            :data-importance="runs.run.importance"
          >
            {{ t(`runs.importance.${runs.run.importance}`) }}
          </span>
          <span class="status" :data-status="runs.run.status" data-testid="run-status">
            {{ t(`runs.status.${runs.run.status}`) }}
          </span>
          <BaseButton
            v-if="runs.canStart"
            size="sm"
            :loading="runs.isBusy('start')"
            data-testid="run-start"
            @click="runs.start()"
          >
            {{ t('runs.start') }}
          </BaseButton>
          <BaseButton
            v-if="runs.isActive"
            size="sm"
            variant="danger"
            :loading="runs.isBusy('stop')"
            data-testid="run-stop"
            @click="onStop"
          >
            {{ t('runs.stop') }}
          </BaseButton>
        </template>
      </div>
    </header>

    <p v-if="runs.loadError" class="error" role="alert">{{ runs.loadError }}</p>
    <div v-if="!runs.loaded" class="loading"><Spinner /> {{ t('common.loading') }}…</div>

    <RunHistoryPanel
      v-if="showHistory"
      :entries="runs.history"
      :loading="runs.isBusy('history')"
      @open="(id) => runs.openHistoryRun(id)"
      @refresh="runs.loadHistory()"
    />

    <!-- Create form: no run, or the previous one is finished. -->
    <form v-if="showCreate" class="create card" data-testid="run-create-form" @submit.prevent="onCreate">
      <h2>{{ t('runs.newRun') }}</h2>
      <BaseField :label="t('runs.goal')">
        <textarea
          v-model="goal"
          class="goal-input"
          rows="4"
          data-testid="run-goal"
          :placeholder="t('runs.goalPlaceholder')"
          required
        ></textarea>
      </BaseField>
      <div class="create-row">
        <BaseField :label="t('runs.workspace')" class="grow">
          <div class="ws-row">
            <BaseInput
              v-model="workspace"
              data-testid="run-workspace"
              :placeholder="t('runs.workspacePlaceholder')"
              required
            />
            <BaseButton size="sm" variant="secondary" data-testid="run-pick-workspace" @click="pickerOpen = true">
              {{ t('runs.browse') }}
            </BaseButton>
          </div>
        </BaseField>
        <BaseField :label="t('runs.provider')">
          <BaseSelect v-model="provider" :options="providerOptions" />
        </BaseField>
        <BaseField :label="t('runs.council.builderModel')">
          <BaseSelect v-model="builderModel" data-testid="run-builder-model" :options="modelOptions(provider)" />
        </BaseField>
        <BaseField :label="t('runs.council.effort')">
          <BaseSelect v-model="builderEffort" data-testid="run-builder-effort" :options="effortOptions(provider)" />
        </BaseField>
        <BaseField :label="t('runs.reviewPolicy')">
          <BaseSelect v-model="reviewPolicy" :options="reviewOptions" />
        </BaseField>
        <BaseField :label="t('runs.verifyPolicy')">
          <BaseSelect v-model="verifyPolicy" :options="verifyOptions" />
        </BaseField>
        <BaseField :label="t('runs.importanceLabel')">
          <BaseSelect v-model="importance" data-testid="run-importance" :options="importanceOptions" />
        </BaseField>
      </div>
      <p class="hint">{{ t('runs.importanceHint') }}</p>

      <!-- Explicit council roster: how many agents from which provider, on which model. -->
      <fieldset class="council">
        <legend>{{ t('runs.council.title') }}</legend>
        <p class="hint">{{ t('runs.council.hint') }}</p>
        <div v-for="p in PROVIDERS" :key="p" class="council-row">
          <span class="council-name">{{ providerLabel(p) }}</span>
          <BaseField :label="t('runs.council.count')">
            <BaseSelect v-model="councilCounts[p]" :data-testid="`run-council-count-${p}`" :options="countOptions" />
          </BaseField>
          <BaseField :label="t('runs.council.model')">
            <BaseSelect v-model="councilModels[p]" :data-testid="`run-council-model-${p}`" :options="modelOptions(p)" />
          </BaseField>
          <BaseField :label="t('runs.council.effort')">
            <BaseSelect
              v-model="councilEfforts[p]"
              :data-testid="`run-council-effort-${p}`"
              :options="effortOptions(p)"
            />
          </BaseField>
        </div>
        <p class="council-total" data-testid="run-council-total">{{ t('runs.council.total') }}: {{ councilTotal }}</p>
      </fieldset>

      <BaseButton type="submit" data-testid="run-create" :loading="runs.isBusy('create') || runs.isBusy('start')">
        {{ t('runs.createAndStart') }}
      </BaseButton>
    </form>

    <EmptyState v-else-if="runs.loaded && !runs.run" :title="t('runs.noRun')" icon="🚀" />

    <template v-if="runs.run">
      <RunChangesPanel
        v-if="showChanges"
        :changes="runs.changes"
        :loading="runs.isBusy('changes')"
        @refresh="runs.loadChanges()"
      />

      <!-- Per-agent live terminals + attached steering (intervene while watching). -->
      <RunTerminalsPanel
        v-if="showTerminals"
        :terminals="runs.terminalList"
        :active="runs.isActive"
        :steer-busy="runs.isBusy('steer')"
        @steer="(body, interrupt) => runs.steer(body, interrupt)"
      />

      <div class="layout">
        <!-- Work graph -->
        <div class="card graph" :aria-label="t('runs.graph')">
          <h2>{{ t('runs.graph') }}</h2>
          <p class="goal" :title="runs.run.goal">{{ runs.run.goal }}</p>
          <ul class="items">
            <li v-for="item in runs.items" :key="item.id">
              <button
                type="button"
                class="item"
                :data-status="item.status"
                :data-testid="`run-item-${item.id}`"
                @click="selectedItemId = item.id"
              >
                <span class="item-head">
                  <span class="kind" :title="item.kind">{{ KIND_ICONS[item.kind] }}</span>
                  <strong>{{ item.id }}</strong>
                  <span class="title">{{ item.title }}</span>
                  <span class="badge" :data-status="item.status">{{ itemStatusLabel(item) }}</span>
                </span>
                <span v-if="item.dependsOn.length" class="deps">⇐ {{ item.dependsOn.join(', ') }}</span>
                <span v-if="item.resultSummary" class="summary">{{ item.resultSummary }}</span>
                <span v-if="item.error" class="item-error">{{ item.error }}</span>
                <span v-if="item.usage?.costUsd" class="cost">${{ item.usage.costUsd.toFixed(4) }}</span>
              </button>
            </li>
          </ul>

          <h3 v-if="runs.run.verifications.length">{{ t('runs.checks') }}</h3>
          <ul class="checks">
            <li v-for="check in runs.run.verifications" :key="check.id + check.at" :data-outcome="check.outcome">
              <code>{{ check.command }}</code>
              <span class="badge" :data-status="check.outcome === 'passed' ? 'done' : 'blocked'">
                {{ check.outcome }} (exit {{ check.exitCode ?? '—' }})
              </span>
            </li>
          </ul>

          <div class="usage" :aria-label="t('runs.usage')">
            <span>{{ runs.run.usage.turns }} {{ t('runs.turns') }}</span>
            <span>{{ formatTokens() }} {{ t('runs.tokens') }}</span>
            <span>{{ t('runs.cost') }}: {{ formatCost() }}</span>
          </div>
        </div>

        <!-- Live activity + steering -->
        <div class="card activity" :aria-label="t('runs.events')">
          <div class="activity-head">
            <h2>{{ t('runs.events') }}</h2>
            <label class="verbose">
              <input v-model="verboseFeed" type="checkbox" data-testid="run-verbose" />
              {{ t('runs.verbose') }}
            </label>
          </div>
          <ul ref="feedEl" class="feed" aria-live="polite" data-testid="run-feed">
            <li v-for="event in eventFeed" :key="event.seq" :data-type="event.type">
              <span class="seq">#{{ event.seq }}</span>
              <span class="line">{{ eventLine(event) }}</span>
            </li>
          </ul>
          <form class="steer" @submit.prevent="onSteer(false)">
            <BaseInput v-model="steering" data-testid="run-steer-input" :placeholder="t('runs.steerPlaceholder')" />
            <BaseButton
              type="submit"
              size="sm"
              data-testid="run-steer"
              :loading="runs.isBusy('steer')"
              :disabled="!steering.trim()"
            >
              {{ t('runs.steer') }}
            </BaseButton>
            <BaseButton
              size="sm"
              variant="danger"
              data-testid="run-steer-now"
              :title="t('runs.steerNowHint')"
              :disabled="!steering.trim() || !runs.isActive"
              @click="onSteer(true)"
            >
              {{ t('runs.steerNow') }}
            </BaseButton>
          </form>
        </div>
      </div>
    </template>

    <!-- Work-item drill-down -->
    <RunItemModal v-if="selectedItem" :item="selectedItem" :events="runs.events" @close="selectedItemId = null" />

    <!-- Read-only view of a past run opened from history -->
    <BaseModal
      v-if="runs.historyRun"
      :title="`${runs.historyRun.runId} — ${t(`runs.status.${runs.historyRun.status}`)}`"
      size="lg"
      @close="runs.openHistoryRun(null)"
    >
      <div class="history-run">
        <p class="goal">{{ runs.historyRun.goal }}</p>
        <p v-if="runs.historyRun.message" class="note">{{ runs.historyRun.message }}</p>
        <ul class="items">
          <li v-for="item in runs.historyRun.graph.items" :key="item.id" class="item static" :data-status="item.status">
            <span class="item-head">
              <span class="kind">{{ KIND_ICONS[item.kind] }}</span>
              <strong>{{ item.id }}</strong>
              <span class="title">{{ item.title }}</span>
              <span class="badge" :data-status="item.status">{{ t(`runs.itemStatus.${item.status}`) }}</span>
            </span>
            <span v-if="item.resultSummary" class="summary">{{ item.resultSummary }}</span>
          </li>
        </ul>
        <div class="usage">
          <span>{{ runs.historyRun.usage.turns }} {{ t('runs.turns') }}</span>
          <span>
            {{ t('runs.cost') }}:
            {{ runs.historyRun.usage.costUsd ? `$${runs.historyRun.usage.costUsd.toFixed(4)}` : '—' }}
          </span>
          <span>{{ runs.historyRun.workspace }}</span>
        </div>
      </div>
    </BaseModal>

    <FolderPicker
      v-if="pickerOpen"
      :initial="workspace || undefined"
      @select="
        (path) => {
          workspace = path;
          pickerOpen = false;
        }
      "
      @close="pickerOpen = false"
    />
  </section>
</template>

<style scoped>
.runs {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
  height: 100%;
  overflow: auto;
}
.runs-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.runs-header h1 {
  margin: 0;
  font-size: 20px;
}
.subtitle {
  margin: 4px 0 0;
  color: var(--text-dim);
  font-size: 13px;
}
.controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.status {
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.status[data-status='running'] {
  color: var(--ok, #4ade80);
  border-color: currentColor;
}
.status[data-status='blocked'],
.status[data-status='failed'] {
  color: var(--danger, #f87171);
  border-color: currentColor;
}
.error {
  color: var(--danger, #f87171);
}
.loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-dim);
}
.card {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
  background: var(--bg-elev);
  padding: 14px;
}
.card h2 {
  margin: 0 0 10px;
  font-size: 15px;
}
.create {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 900px;
}
.goal-input {
  width: 100%;
  resize: vertical;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
  padding: 8px;
  font: inherit;
}
.create-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: flex-end;
}
.grow {
  flex: 1 1 300px;
}
.ws-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.ws-row :deep(input) {
  flex: 1;
}
.layout {
  display: grid;
  grid-template-columns: minmax(340px, 1.2fr) minmax(300px, 1fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 1000px) {
  .layout {
    grid-template-columns: 1fr;
  }
}
.goal {
  color: var(--text-dim);
  font-size: 13px;
  margin: 0 0 10px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.items,
.checks,
.feed {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.item {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  width: 100%;
  text-align: left;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  cursor: pointer;
}
.item.static {
  cursor: default;
}
.item:hover:not(.static) {
  border-color: var(--accent, #60a5fa);
}
.item[data-status='running'],
.item[data-status='verifying'] {
  border-color: var(--accent, #60a5fa);
}
.item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.title {
  color: var(--text);
}
.badge {
  margin-left: auto;
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.03em;
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
.deps,
.summary,
.cost {
  color: var(--text-dim);
  font-size: 12px;
}
.item-error {
  color: var(--danger, #f87171);
  font-size: 12px;
}
.checks li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.checks code {
  color: var(--text-dim);
}
.usage {
  display: flex;
  gap: 16px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 12px;
  flex-wrap: wrap;
}
.activity {
  display: flex;
  flex-direction: column;
  min-height: 320px;
}
.feed {
  flex: 1;
  overflow: auto;
  max-height: 55vh;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 12px;
}
.feed li {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  border-bottom: 1px dashed color-mix(in srgb, var(--border) 40%, transparent);
}
.feed .seq {
  color: var(--text-dim);
  min-width: 44px;
}
.feed li[data-type='verification'] .line {
  color: var(--accent, #60a5fa);
}
.feed li[data-type='run-status'] .line {
  font-weight: 600;
}
.steer {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.steer :deep(input) {
  flex: 1;
}
.activity-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.activity-head h2 {
  margin: 0 0 10px;
}
.verbose {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
}
.hint {
  color: var(--text-dim);
  font-size: 12px;
  margin: 0;
}
.council {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
}
.council legend {
  font-size: 13px;
  font-weight: 600;
  padding: 0 4px;
}
.council-row {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.council-name {
  min-width: 110px;
  font-size: 13px;
  padding-bottom: 8px;
}
.council-total {
  color: var(--text-dim);
  font-size: 12px;
  margin: 0;
}
.status.importance[data-importance='critical'] {
  color: var(--danger, #f87171);
  border-color: currentColor;
}
.status.importance[data-importance='high'] {
  color: var(--accent, #60a5fa);
  border-color: currentColor;
}
.history-run {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 13px;
}
.history-run .goal {
  -webkit-line-clamp: 6;
}
.note {
  color: var(--text-dim);
  margin: 0;
}
</style>
