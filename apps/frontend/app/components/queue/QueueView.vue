<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import { useDialog } from '~/composables/useDialog';
import { useSocket } from '~/composables/useSocket';
import { useT } from '~/composables/useT';
import { useConnectionStore } from '~/stores/connection';
import { useQueueStore } from '~/stores/queue';
import type {
  QueueBulkAction,
  QueueJobStatus,
  QueueJobView,
  QueueProvider,
  QueueRule,
  QueueRuleOperator,
  QueueRuleProvider,
  QueueState,
  QueueStepStatus,
  QueueTargetType,
  ShellKind,
} from '~/types';

withDefaults(defineProps<{ showHeader?: boolean }>(), { showHeader: false });
const emit = defineEmits<{ back: [] }>();

const queue = useQueueStore();
const conn = useConnectionStore();
const socket = useSocket();
const { t } = useT();

const selectedJobId = ref<string | null>(null);
const nowMs = ref(Date.now());
const selectedIds = ref<Set<string>>(new Set());
const dragId = ref<string | null>(null);
const dragOverId = ref<string | null>(null);
const activeList = ref<'live' | 'history'>('live');
const enqueueTarget = ref<QueueTargetType>('project');
const providerOrder: QueueProvider[] = ['claude', 'codex', 'antigravity', 'mixed'];
const draft = reactive({
  projectName: '',
  workspacePath: '',
  prompt: '',
  provider: 'claude' as QueueProvider,
  priority: 0,
  maxAttempts: 1,
});
const terminalDraft = reactive({
  name: '',
  cwd: '',
  shellKind: 'system-default' as ShellKind,
  initialCommand: '',
});
const teamDraft = reactive({
  mode: 'create' as 'create' | 'append',
  runId: '',
  workspacePath: '',
  body: '',
});
const ruleDraft = reactive({
  name: t('queue.rules.defaultName'),
  provider: 'claude' as QueueRuleProvider,
  windowKey: 'any',
  operator: 'gte' as QueueRuleOperator,
  threshold: 90,
  enabled: true,
});
const editingRuleId = ref<string | null>(null);

const ruleProviders: QueueRuleProvider[] = ['claude', 'codex', 'antigravity', 'mixed', 'any'];
const ruleOperators: QueueRuleOperator[] = ['gte', 'gt', 'lte', 'lt', 'eq'];

let clock: ReturnType<typeof setInterval> | null = null;
let unsubscribeQueueState: (() => void) | null = null;

const jobs = computed(() => queue.jobs);
const isPipelineV2 = computed(() => queue.queuePipelineV2);
const pipelineModeLabel = computed(() => (isPipelineV2.value ? t('queue.pipeline.v2') : t('queue.pipeline.legacy')));
const pipelineModeDetail = computed(() =>
  isPipelineV2.value
    ? t('queue.pipeline.activeDetail')
    : t('queue.pipeline.legacyDetail'),
);
const shownJobs = computed(() => (isPipelineV2.value && activeList.value === 'history' ? queue.historyItems : jobs.value));
const jobListLabel = computed(() => {
  if (!isPipelineV2.value) return t('queue.pipeline.orderedQueueJobs');
  return activeList.value === 'history' ? t('queue.pipeline.historyItems') : t('queue.pipeline.liveJobs');
});
const selectedJob = computed(() => shownJobs.value.find((job) => job.id === selectedJobId.value) ?? shownJobs.value[0] ?? null);
const activeProgress = computed(() => progressFor(queue.activeJob));
const enabledRules = computed(() => queue.rules.filter((rule) => rule.enabled));
const disabledRules = computed(() => queue.rules.filter((rule) => !rule.enabled));
const savingRule = computed(() =>
  queue.isBusy(editingRuleId.value ? `rule:update:${editingRuleId.value}` : 'rule:create'),
);
const canSaveRule = computed(
  () => ruleDraft.name.trim().length > 0 && Number.isFinite(ruleDraft.threshold) && ruleDraft.threshold >= 0 && ruleDraft.threshold <= 100 && !savingRule.value,
);
const canSubmit = computed(() => {
  if (queue.isBusy('enqueue')) return false;
  if (!isPipelineV2.value || enqueueTarget.value === 'project') return draft.prompt.trim().length > 0;
  if (enqueueTarget.value === 'terminal') return terminalDraft.name.trim().length > 0;
  if (teamDraft.mode === 'append' && !teamDraft.runId.trim()) return false;
  return teamDraft.body.trim().length > 0;
});
const selectedEvents = computed(() => {
  const job = selectedJob.value;
  if (!job) return queue.events.slice(0, 30);
  return queue.events.filter((event) => event.jobId === job.id || event.jobId === null).slice(0, 30);
});

const hasRecovery = computed(() => jobs.value.some(isRecoveryJob));

const lanes = computed(() => {
  const running = queue.state?.runningByProvider;
  const limits = queue.state?.providerConcurrency;
  if (!running || !limits) return [];
  return providerOrder.map((provider) => ({
    provider,
    running: running[provider] ?? 0,
    limit: limits[provider] ?? 0,
  }));
});

const selectedCount = computed(() => selectedIds.value.size);
const allSelectableIds = computed(() =>
  isPipelineV2.value && activeList.value === 'history' ? [] : jobs.value.map((job) => job.id),
);
const allSelected = computed(
  () => allSelectableIds.value.length > 0 && allSelectableIds.value.every((id) => selectedIds.value.has(id)),
);

function isReorderable(job: QueueJobView): boolean {
  if (isPipelineV2.value && activeList.value === 'history') return false;
  return job.status === 'queued' || job.status === 'retrying';
}

function isSelected(id: string): boolean {
  return selectedIds.value.has(id);
}

function toggleSelected(id: string): void {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

function toggleSelectAll(): void {
  selectedIds.value = allSelected.value ? new Set() : new Set(allSelectableIds.value);
}

function clearSelection(): void {
  selectedIds.value = new Set();
}

const dialog = useDialog();

async function runBulk(action: QueueBulkAction): Promise<void> {
  if (isPipelineV2.value && activeList.value === 'history') return;
  const ids = [...selectedIds.value];
  if (ids.length === 0 || queue.isBusy('bulk')) return;
  if (action === 'cancel' || action === 'delete') {
    const verb = action === 'delete' ? t('queue.jobs.delete') : t('queue.jobs.cancel');
    const ok = await dialog.confirm({
      title: t('queue.bulk.confirmTitle', { action: verb, n: ids.length }),
      message: t('queue.bulk.confirmMessage', { action: verb, n: ids.length }),
      confirmText: verb,
      danger: true,
    });
    if (!ok) return;
  }
  try {
    await queue.bulk(action, ids);
    clearSelection();
  } catch {
    /* surfaced through queue.actionError */
  }
}

function onDragStart(job: QueueJobView, ev: DragEvent): void {
  if (!isReorderable(job)) {
    ev.preventDefault();
    return;
  }
  dragId.value = job.id;
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', job.id);
  }
}

function onDragOver(job: QueueJobView, ev: DragEvent): void {
  if (!dragId.value || !isReorderable(job) || job.id === dragId.value) return;
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
  dragOverId.value = job.id;
}

function onDragLeave(job: QueueJobView): void {
  if (dragOverId.value === job.id) dragOverId.value = null;
}

async function onDrop(target: QueueJobView, ev: DragEvent): Promise<void> {
  ev.preventDefault();
  const sourceId = dragId.value;
  dragId.value = null;
  dragOverId.value = null;
  if (!sourceId || sourceId === target.id || !isReorderable(target)) return;
  if (queue.isBusy('reorder')) return;

  const ids = jobs.value.map((job) => job.id);
  const from = ids.indexOf(sourceId);
  const to = ids.indexOf(target.id);
  if (from < 0 || to < 0) return;
  ids.splice(from, 1);
  ids.splice(to, 0, sourceId);
  try {
    // Optimistic order is reconciled from the next queue.state the reorder returns.
    await queue.reorder(ids);
  } catch {
    /* surfaced through queue.actionError */
  }
}

function onDragEnd(): void {
  dragId.value = null;
  dragOverId.value = null;
}

// Roving-tabindex keyboard navigation for the listbox of jobs. ArrowUp/Down moves
// the active row (and DOM focus); Enter/Space selects the focused row. Native
// drag-and-drop above is unaffected — this only adds keyboard parity.
function focusJobRow(id: string): void {
  const el = document.querySelector<HTMLElement>(`[data-testid="job-row-${id}"]`);
  el?.focus();
}

function onJobListKeydown(ev: KeyboardEvent): void {
  const items = shownJobs.value;
  if (items.length === 0) return;
  const currentId = selectedJob.value?.id ?? items[0]!.id;
  const idx = items.findIndex((job) => job.id === currentId);
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    const delta = ev.key === 'ArrowDown' ? 1 : -1;
    const next = Math.min(items.length - 1, Math.max(0, idx + delta));
    const nextId = items[next]!.id;
    selectedJobId.value = nextId;
    focusJobRow(nextId);
  } else if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    selectedJobId.value = currentId;
  } else if (ev.key === 'Home') {
    ev.preventDefault();
    selectedJobId.value = items[0]!.id;
    focusJobRow(items[0]!.id);
  } else if (ev.key === 'End') {
    ev.preventDefault();
    const last = items[items.length - 1]!.id;
    selectedJobId.value = last;
    focusJobRow(last);
  }
}

watch(
  shownJobs,
  (items) => {
    if (items.length === 0) {
      selectedJobId.value = null;
      return;
    }
    if (!selectedJobId.value || !items.some((job) => job.id === selectedJobId.value)) {
      selectedJobId.value = items[0]!.id;
    }
  },
  { immediate: true },
);

watch(
  () => conn.status,
  (status) => {
    if (status === 'connected') void queue.load({ quiet: true }).catch(() => {});
  },
);

onMounted(() => {
  void queue.load().catch(() => {});
  unsubscribeQueueState = socket.onServerEvent('queue.state', (msg) => {
    const state = (msg as unknown as { state?: QueueState }).state;
    if (state) queue.applyState(state);
  });
  clock = setInterval(() => {
    nowMs.value = Date.now();
  }, 1000);
});

watch(
  () => queue.queuePipelineV2,
  (enabled) => {
    if (enabled) void queue.loadHistory({ limit: 50 }).catch(() => {});
  },
);

watch(activeList, (tab) => {
  clearSelection();
  if (tab === 'history' && !queue.historyLoaded) void queue.loadHistory({ limit: 50 }).catch(() => {});
});

onBeforeUnmount(() => {
  if (clock) clearInterval(clock);
  unsubscribeQueueState?.();
});

function progressFor(job: QueueJobView | null): { completed: number; total: number; percent: number } {
  if (!job) return { completed: 0, total: 0, percent: 0 };
  const total = job.steps.length;
  const completed = job.steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length;
  return { completed, total, percent: total ? Math.round((completed / total) * 100) : 0 };
}

function statusLabel(status: QueueJobStatus | QueueStepStatus): string {
  return status.replace(/_/g, ' ');
}

function providerLabel(provider: QueueProvider): string {
  if (provider === 'codex') return t('common.providers.codex');
  if (provider === 'antigravity') return t('common.providers.antigravity');
  if (provider === 'mixed') return t('common.providers.mixed');
  return t('common.providers.claude');
}

function targetLabel(target: QueueTargetType | null | undefined): string {
  if (target === 'terminal') return t('queue.target.terminal');
  if (target === 'team') return t('queue.target.team');
  return t('queue.target.project');
}

function ruleLabel(rule: { provider: string; windowKey: string; operator: string; threshold: number }): string {
  const op = rule.operator === 'gte' ? '>=' : rule.operator === 'lte' ? '<=' : rule.operator;
  return `${rule.provider} ${rule.windowKey} ${op} ${rule.threshold}%`;
}

function jobTitle(job: QueueJobView): string {
  return job.title?.trim() || job.projectName?.trim() || t('queue.jobs.fallbackTitle', { id: job.id.slice(0, 8) });
}

function shortPrompt(job: QueueJobView): string {
  const prompt = (job.body || job.prompt).replace(/\s+/g, ' ').trim();
  return prompt.length > 140 ? `${prompt.slice(0, 137)}...` : prompt;
}

function targetRefText(job: QueueJobView): string {
  if (!job.targetRef || Object.keys(job.targetRef).length === 0) return t('queue.target.none');
  return JSON.stringify(job.targetRef);
}

function failureReason(job: QueueJobView): string {
  return job.blockedReason || queue.events.find((event) => event.jobId === job.id && event.type === 'queue.failed')?.message || t('queue.jobs.noFailureReason');
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return t('queue.jobs.notSet');
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString();
}

function countdown(iso: string | null): string {
  if (!iso) return t('queue.jobs.waitingSnapshot');
  const ms = new Date(iso).getTime() - nowMs.value;
  if (!Number.isFinite(ms) || ms <= 0) return t('queue.jobs.readyToResume');
  const total = Math.ceil(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function isTerminal(status: QueueJobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}

function canPause(job: QueueJobView): boolean {
  return job.status === 'queued' || job.status === 'retrying' || job.status === 'running' || job.status === 'blocked_by_limit';
}

function canResume(job: QueueJobView): boolean {
  return job.status === 'paused' || job.status === 'blocked_by_limit';
}

function canRetry(job: QueueJobView): boolean {
  return job.status === 'failed' || job.status === 'canceled';
}

function isRecoveryJob(job: QueueJobView): boolean {
  if (job.status !== 'retrying') return false;
  if (job.blockedReason?.toLowerCase().includes('recover')) return true;
  return job.steps.some((step) => step.error?.toLowerCase().includes('recover'));
}

function statusClass(status: QueueJobStatus | QueueStepStatus): string {
  return `s-${status}`;
}

async function submitEnqueue(): Promise<void> {
  if (!canSubmit.value) return;
  try {
    if (!isPipelineV2.value || enqueueTarget.value === 'project') {
      await queue.enqueue({
        prompt: draft.prompt.trim(),
        projectName: draft.projectName.trim() || undefined,
        workspacePath: draft.workspacePath.trim() || undefined,
        provider: draft.provider,
        priority: Number.isFinite(draft.priority) ? draft.priority : 0,
        maxAttempts: Number.isFinite(draft.maxAttempts) && draft.maxAttempts > 0 ? draft.maxAttempts : 1,
        ...(isPipelineV2.value
          ? {
              target: { type: 'project' },
              payload: {
                projectName: draft.projectName.trim() || undefined,
                workspacePath: draft.workspacePath.trim() || undefined,
                provider: draft.provider,
              },
            }
          : {}),
      });
    } else if (enqueueTarget.value === 'terminal') {
      const command = terminalDraft.initialCommand.trim();
      await queue.enqueue({
        prompt: command || terminalDraft.name.trim(),
        body: command || undefined,
        title: terminalDraft.name.trim(),
        priority: Number.isFinite(draft.priority) ? draft.priority : 0,
        maxAttempts: Number.isFinite(draft.maxAttempts) && draft.maxAttempts > 0 ? draft.maxAttempts : 1,
        target: { type: 'terminal' },
        payload: {
          name: terminalDraft.name.trim(),
          cwd: terminalDraft.cwd.trim() || undefined,
          initialCommand: command || undefined,
          shell: { kind: terminalDraft.shellKind },
        },
      });
      terminalDraft.name = '';
      terminalDraft.cwd = '';
      terminalDraft.initialCommand = '';
      terminalDraft.shellKind = 'system-default';
    } else {
      await queue.enqueue({
        prompt: teamDraft.body.trim(),
        body: teamDraft.body.trim(),
        title: teamDraft.mode === 'append' ? t('queue.enqueue.appendTitle', { runId: teamDraft.runId.trim() }) : t('queue.enqueue.createTeamRunTitle'),
        priority: Number.isFinite(draft.priority) ? draft.priority : 0,
        maxAttempts: Number.isFinite(draft.maxAttempts) && draft.maxAttempts > 0 ? draft.maxAttempts : 1,
        target: { type: 'team' },
        payload: {
          mode: teamDraft.mode,
          runId: teamDraft.mode === 'append' ? teamDraft.runId.trim() : undefined,
          workspacePath: teamDraft.mode === 'create' ? teamDraft.workspacePath.trim() || undefined : undefined,
        },
      });
      teamDraft.body = '';
      teamDraft.runId = '';
      teamDraft.workspacePath = '';
      teamDraft.mode = 'create';
    }
    draft.prompt = '';
    draft.projectName = '';
    draft.workspacePath = '';
    draft.priority = 0;
    draft.maxAttempts = 1;
  } catch {
    /* surfaced through queue.actionError */
  }
}

async function retryAsNew(job: QueueJobView): Promise<void> {
  if (queue.isBusy('enqueue')) return;
  await queue.enqueue({
    prompt: job.prompt,
    body: job.body ?? undefined,
    title: job.title ?? job.projectName ?? undefined,
    workspacePath: job.workspacePath,
    projectName: job.projectName ?? undefined,
    provider: job.provider,
    maxAttempts: job.maxAttempts,
    target: job.targetType ? { type: job.targetType } : undefined,
    payload: job.targetPayload && typeof job.targetPayload === 'object' ? (job.targetPayload as Record<string, unknown>) : undefined,
  });
  activeList.value = 'live';
}

async function archiveHistoryJob(job: QueueJobView): Promise<void> {
  if (queue.isBusy('bulk')) return;
  const ok = await dialog.confirm({
    title: t('queue.history.archiveTitle'),
    message: t('queue.history.archiveMessage', { title: jobTitle(job) }),
    confirmText: t('queue.history.archive'),
    danger: true,
  });
  if (!ok) return;
  await queue.bulk('delete', [job.id]);
  await queue.loadHistory({ limit: 50 }).catch(() => {});
  selectedJobId.value = null;
}

function resetRuleDraft(): void {
  editingRuleId.value = null;
  Object.assign(ruleDraft, {
    name: t('queue.rules.defaultName'),
    provider: 'claude' as QueueRuleProvider,
    windowKey: 'any',
    operator: 'gte' as QueueRuleOperator,
    threshold: 90,
    enabled: true,
  });
}

function editRule(rule: QueueRule): void {
  editingRuleId.value = rule.id;
  Object.assign(ruleDraft, {
    name: rule.name,
    provider: rule.provider,
    windowKey: rule.windowKey,
    operator: rule.operator,
    threshold: rule.threshold,
    enabled: rule.enabled,
  });
}

async function saveRule(): Promise<void> {
  if (!canSaveRule.value) return;
  const threshold = Number(ruleDraft.threshold);
  await queue.saveRule({
    id: editingRuleId.value ?? undefined,
    name: ruleDraft.name.trim(),
    enabled: ruleDraft.enabled,
    provider: ruleDraft.provider,
    windowKey: ruleDraft.windowKey.trim() || 'any',
    metric: 'percent_used',
    operator: ruleDraft.operator,
    threshold,
    action: 'block_dispatch',
    config: { resumeFrom: 'reset_at' },
  });
  resetRuleDraft();
}

async function deleteRule(rule: QueueRule): Promise<void> {
  await queue.deleteRule(rule.id);
  if (editingRuleId.value === rule.id) resetRuleDraft();
}

async function moveSelected(delta: -1 | 1): Promise<void> {
  const job = selectedJob.value;
  if (!job || !isReorderable(job) || queue.isBusy('reorder')) return;
  const ids = jobs.value.map((item) => item.id);
  const idx = ids.indexOf(job.id);
  const next = idx + delta;
  if (idx < 0 || next < 0 || next >= ids.length) return;
  [ids[idx], ids[next]] = [ids[next]!, ids[idx]!];
  try {
    await queue.reorder(ids);
  } catch {
    /* surfaced through queue.actionError */
  }
}

async function runControl(action: 'pause' | 'resume' | 'cancel' | 'retry'): Promise<void> {
  const job = selectedJob.value;
  if (!job || (isPipelineV2.value && activeList.value === 'history')) return;
  try {
    if (action === 'pause') await queue.pause(job.id);
    else if (action === 'resume') await queue.resume(job.id);
    else if (action === 'cancel') await queue.cancel(job.id);
    else await queue.retry(job.id);
  } catch {
    /* surfaced through queue.actionError */
  }
}
</script>

<template>
  <div class="queue-page">
    <header v-if="showHeader" class="qhead">
      <div class="brand">
        <b>{{ t('queue.title') }}</b>
        <span class="sub">{{ t('queue.subtitle') }}</span>
        <span class="conn" :class="conn.status" :title="t('queue.connection.backendStatus', { status: conn.status })" />
      </div>
      <span class="spacer" />
      <span v-if="queue.updatedAt" class="updated">{{ t('queue.connection.synced', { time: formatTime(queue.updatedAt) }) }}</span>
      <BaseButton size="sm" variant="secondary" data-testid="refresh-queue" :loading="queue.loading" @click="queue.load().catch(() => {})">
        {{ t('common.refresh') }}
      </BaseButton>
      <BaseButton size="sm" variant="secondary" @click="emit('back')">{{ t('queue.actions.backToTerminals') }}</BaseButton>
    </header>

    <main class="qbody">
      <div v-if="conn.status !== 'connected'" class="banner disconnected" data-testid="disconnected-banner">
        {{ t('queue.connection.disconnected', { status: conn.status }) }}
      </div>
      <div v-if="queue.loadError" class="banner error" data-testid="error-banner">
        {{ queue.loadError }}
      </div>
      <div v-if="queue.actionError" class="banner error" data-testid="action-error">
        {{ queue.actionError }}
      </div>
      <div v-if="hasRecovery" class="banner recovery" data-testid="recovery-banner">
        {{ t('queue.summary.recovery') }}
      </div>

      <section class="summary">
        <div class="metric active-panel" data-testid="active-panel">
          <span class="label">{{ t('queue.summary.active') }}</span>
          <template v-if="queue.activeJob">
            <b>{{ jobTitle(queue.activeJob) }}</b>
            <span class="meta">
              {{ queue.activeJob.currentStep ?? t('queue.jobs.starting') }} -
              {{ t('queue.jobs.stepsProgress', { completed: activeProgress.completed, total: activeProgress.total }) }}
            </span>
            <div
              class="progress"
              role="progressbar"
              :aria-label="t('queue.summary.activeProgress')"
              :aria-valuenow="activeProgress.percent"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <span :style="{ width: `${activeProgress.percent}%` }" />
            </div>
          </template>
          <template v-else>
            <b>{{ t('queue.summary.noActiveJob') }}</b>
            <span class="meta">{{ t('queue.summary.readyPaused', { ready: queue.dispatchableJobs.length, paused: queue.pausedJobs.length }) }}</span>
          </template>
        </div>

        <div class="metric blocked-panel" :class="{ hot: queue.blockedJobs.length > 0 }" data-testid="blocked-panel">
          <span class="label">{{ t('queue.summary.blockedByLimit') }}</span>
          <template v-if="queue.blockedJobs.length">
            <b>{{ t('queue.summary.blockedJobs', { n: queue.blockedJobs.length }) }}</b>
            <span class="meta">{{ queue.blockedJobs[0]?.blockedReason ?? t('queue.summary.blockedByRule') }}</span>
            <span class="eta">{{ t('queue.summary.resume', { time: countdown(queue.blockedJobs[0]?.resumeAfter ?? null) }) }}</span>
          </template>
          <template v-else>
            <b>{{ t('queue.summary.clear') }}</b>
            <span class="meta">{{ t('queue.summary.noBlockedJobs') }}</span>
          </template>
        </div>

        <div class="metric lanes-panel" data-testid="lanes-panel">
          <span class="label">{{ t('queue.summary.providerLanes') }}</span>
          <div v-if="lanes.length" class="lanes">
            <span
              v-for="lane in lanes"
              :key="lane.provider"
              class="lane"
              :class="{ full: lane.running >= lane.limit }"
              :data-provider="lane.provider"
            >
              {{ providerLabel(lane.provider) }} {{ lane.running }}/{{ lane.limit }}
            </span>
          </div>
          <span v-else class="meta">{{ t('queue.summary.waitingForState') }}</span>
        </div>

        <div class="metric pipeline-panel" data-testid="pipeline-mode-panel">
          <span class="label">{{ t('queue.summary.pipeline') }}</span>
          <b>{{ pipelineModeLabel }}</b>
          <span class="meta">{{ pipelineModeDetail }}</span>
        </div>

        <div class="metric rules-panel" data-testid="rules-panel">
          <span class="label">{{ t('queue.summary.rules') }}</span>
          <b>{{ t('queue.summary.enabledRules', { n: enabledRules.length }) }}</b>
          <span v-if="enabledRules[0]" class="meta">{{ enabledRules.map(ruleLabel).join(', ') }}</span>
          <span v-else class="meta">{{ t('queue.summary.noEnabledRules') }}</span>
          <span v-if="disabledRules.length" class="eta">{{ t('queue.summary.disabledRules', { n: disabledRules.length }) }}</span>
        </div>
      </section>

      <section class="rule-editor" data-testid="rule-editor">
        <div class="rule-editor-head">
          <div>
            <b>{{ t('queue.rules.management') }}</b>
            <span>{{ t('queue.rules.description') }}</span>
          </div>
          <BaseButton size="sm" variant="secondary" :disabled="!editingRuleId || savingRule" @click="resetRuleDraft">{{ t('queue.rules.newRule') }}</BaseButton>
        </div>

        <form class="rule-form" data-testid="rule-form" @submit.prevent="saveRule">
          <label>
            <span>{{ t('queue.rules.name') }}</span>
            <input v-model="ruleDraft.name" data-testid="rule-name" :placeholder="t('queue.rules.placeholders.name')" maxlength="191" />
          </label>
          <label>
            <span>{{ t('queue.rules.provider') }}</span>
            <select v-model="ruleDraft.provider" data-testid="rule-provider">
              <option v-for="item in ruleProviders" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <label>
            <span>{{ t('queue.rules.window') }}</span>
            <input v-model="ruleDraft.windowKey" data-testid="rule-window" :placeholder="t('queue.rules.placeholders.window')" />
          </label>
          <label>
            <span>{{ t('queue.rules.operator') }}</span>
            <select v-model="ruleDraft.operator" data-testid="rule-operator">
              <option v-for="item in ruleOperators" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <label>
            <span>{{ t('queue.rules.threshold') }}</span>
            <input v-model.number="ruleDraft.threshold" data-testid="rule-threshold" type="number" min="0" max="100" step="0.1" />
          </label>
          <label class="rule-enabled">
            <input v-model="ruleDraft.enabled" data-testid="rule-enabled" type="checkbox" />
            <span>{{ t('queue.rules.enabled') }}</span>
          </label>
          <BaseButton variant="primary" data-testid="save-rule" type="submit" :loading="savingRule" :disabled="!canSaveRule">
            {{ editingRuleId ? t('queue.rules.updateRule') : t('queue.rules.createRule') }}
          </BaseButton>
        </form>

        <div v-if="queue.rules.length" class="rule-list" data-testid="rule-list">
          <article v-for="rule in queue.rules" :key="rule.id" class="rule-card">
            <div>
              <b>{{ rule.name }}</b>
              <span>{{ ruleLabel(rule) }} / {{ rule.enabled ? t('queue.rules.enabledStatus') : t('queue.rules.disabled') }}</span>
            </div>
            <BaseButton size="sm" variant="secondary" data-testid="edit-rule" @click="editRule(rule)">{{ t('queue.rules.edit') }}</BaseButton>
            <BaseButton
              size="sm"
              variant="danger"
              data-testid="delete-rule"
              :disabled="queue.isBusy(`rule:delete:${rule.id}`)"
              @click="deleteRule(rule)"
            >
              {{ t('queue.rules.delete') }}
            </BaseButton>
          </article>
        </div>
      </section>

      <section class="content">
        <aside class="left">
          <form class="enqueue" data-testid="enqueue-form" @submit.prevent="submitEnqueue">
        <div v-if="isPipelineV2" class="target-tabs" data-testid="enqueue-target-tabs" role="group" :aria-label="t('queue.target.label')">
          <button
            type="button"
            data-testid="enqueue-target-project"
            :class="{ active: enqueueTarget === 'project' }"
            :aria-pressed="enqueueTarget === 'project'"
            @click="enqueueTarget = 'project'"
          >
            {{ t('queue.target.project') }}
          </button>
          <button
            type="button"
            data-testid="enqueue-target-terminal"
            :class="{ active: enqueueTarget === 'terminal' }"
            :aria-pressed="enqueueTarget === 'terminal'"
            @click="enqueueTarget = 'terminal'"
          >
            {{ t('queue.target.terminal') }}
          </button>
          <button
            type="button"
            data-testid="enqueue-target-team"
            :class="{ active: enqueueTarget === 'team' }"
            :aria-pressed="enqueueTarget === 'team'"
            @click="enqueueTarget = 'team'"
          >
            {{ t('queue.target.team') }}
          </button>
        </div>

            <template v-if="!isPipelineV2 || enqueueTarget === 'project'">
              <div class="form-grid">
                <label>
                  <span>{{ t('queue.enqueue.project') }}</span>
                  <input v-model="draft.projectName" data-testid="enqueue-project" :placeholder="t('queue.enqueue.placeholders.projectName')" />
                </label>
                <label>
                  <span>{{ t('queue.enqueue.provider') }}</span>
                  <select v-model="draft.provider" data-testid="enqueue-provider">
                    <option value="claude">{{ t('common.providers.claude') }}</option>
                    <option value="codex">{{ t('common.providers.codex') }}</option>
                    <option value="antigravity">{{ t('common.providers.antigravity') }}</option>
                    <option value="mixed">{{ t('common.providers.mixed') }}</option>
                  </select>
                </label>
                <label>
                  <span>{{ t('queue.enqueue.priority') }}</span>
                  <input v-model.number="draft.priority" data-testid="enqueue-priority" type="number" step="1" />
                </label>
                <label>
                  <span>{{ t('queue.enqueue.attempts') }}</span>
                  <input v-model.number="draft.maxAttempts" data-testid="enqueue-attempts" type="number" min="1" step="1" />
                </label>
              </div>
              <label>
                <span>{{ t('queue.enqueue.workspace') }}</span>
                <input v-model="draft.workspacePath" data-testid="enqueue-workspace" :placeholder="t('queue.enqueue.placeholders.workspacePath')" />
              </label>
              <label>
                <span>{{ t('queue.enqueue.prompt') }}</span>
                <textarea
                  v-model="draft.prompt"
                  data-testid="enqueue-prompt"
                  rows="5"
                  :placeholder="t('queue.enqueue.placeholders.prompt')"
                />
              </label>
            </template>

            <template v-else-if="enqueueTarget === 'terminal'">
              <div class="form-grid terminal-grid">
                <label>
                  <span>{{ t('queue.enqueue.name') }}</span>
                  <input v-model="terminalDraft.name" data-testid="enqueue-terminal-name" :placeholder="t('queue.enqueue.placeholders.terminalName')" />
                </label>
                <label>
                  <span>{{ t('queue.enqueue.shell') }}</span>
                  <select v-model="terminalDraft.shellKind" data-testid="enqueue-terminal-shell">
                    <option value="system-default">{{ t('queue.enqueue.default') }}</option>
                    <option value="powershell">PowerShell</option>
                    <option value="pwsh">pwsh</option>
                    <option value="cmd">cmd</option>
                    <option value="bash">bash</option>
                  </select>
                </label>
              </div>
              <label>
                <span>{{ t('queue.enqueue.cwd') }}</span>
                <input v-model="terminalDraft.cwd" data-testid="enqueue-terminal-cwd" :placeholder="t('queue.enqueue.placeholders.terminalCwd')" />
              </label>
              <label>
                <span>{{ t('queue.enqueue.command') }}</span>
                <textarea
                  v-model="terminalDraft.initialCommand"
                  data-testid="enqueue-terminal-command"
                  rows="4"
                  :placeholder="t('queue.enqueue.placeholders.terminalCommand')"
                />
              </label>
            </template>

            <template v-else>
              <div class="form-grid team-grid">
                <label>
                  <span>{{ t('queue.enqueue.mode') }}</span>
                  <select v-model="teamDraft.mode" data-testid="enqueue-team-mode">
                    <option value="create">{{ t('queue.enqueue.create') }}</option>
                    <option value="append">{{ t('queue.enqueue.append') }}</option>
                  </select>
                </label>
                <label v-if="teamDraft.mode === 'append'">
                  <span>{{ t('queue.enqueue.runId') }}</span>
                  <input v-model="teamDraft.runId" data-testid="enqueue-team-run-id" :placeholder="t('queue.enqueue.placeholders.teamRunId')" />
                </label>
                <label v-else>
                  <span>{{ t('queue.enqueue.workspace') }}</span>
                  <input v-model="teamDraft.workspacePath" data-testid="enqueue-team-workspace" :placeholder="t('queue.enqueue.placeholders.teamWorkspace')" />
                </label>
              </div>
              <label>
                <span>{{ t('queue.enqueue.body') }}</span>
                <textarea
                  v-model="teamDraft.body"
                  data-testid="enqueue-team-body"
                  rows="5"
                  :placeholder="t('queue.enqueue.placeholders.teamBody')"
                />
              </label>
            </template>

            <BaseButton variant="primary" block data-testid="enqueue-submit" type="submit" :loading="queue.isBusy('enqueue')" :disabled="!canSubmit">
              {{ t('queue.enqueue.submit') }}
            </BaseButton>
          </form>

          <div v-if="isPipelineV2" class="queue-tabs" data-testid="queue-tabs" role="group" :aria-label="t('queue.pipeline.queueListView')">
            <button
              type="button"
              data-testid="queue-tab-live"
              :class="{ active: activeList === 'live' }"
              :aria-pressed="activeList === 'live'"
              @click="activeList = 'live'"
            >
              {{ t('queue.pipeline.live') }} {{ jobs.length }}
            </button>
            <button
              type="button"
              data-testid="queue-tab-history"
              :class="{ active: activeList === 'history' }"
              :aria-pressed="activeList === 'history'"
              @click="activeList = 'history'"
            >
              {{ t('queue.pipeline.history') }} {{ queue.historyCounts.total }}
            </button>
          </div>

          <div class="list-head">
            <label class="select-all" :title="activeList === 'history' ? t('queue.history.rowsReadOnly') : t('queue.jobs.selectAll')">
              <input
                v-if="!isPipelineV2 || activeList === 'live'"
                type="checkbox"
                data-testid="select-all"
                :checked="allSelected"
                :disabled="jobs.length === 0"
                @change="toggleSelectAll"
              />
              <b>{{ isPipelineV2 ? (activeList === 'history' ? t('queue.pipeline.history') : t('queue.pipeline.livePipeline')) : t('queue.pipeline.orderedJobs') }}</b>
            </label>
            <span>{{ t('queue.jobs.total', { n: isPipelineV2 && activeList === 'history' ? queue.historyTotal || queue.historyCounts.total : jobs.length }) }}</span>
          </div>

          <div v-if="selectedCount > 0 && (!isPipelineV2 || activeList === 'live')" class="bulk-bar" data-testid="bulk-bar">
            <span class="bulk-count">{{ t('queue.jobs.selected', { n: selectedCount }) }}</span>
            <div class="bulk-actions">
              <BaseButton size="sm" variant="secondary" data-testid="bulk-pause" :disabled="queue.isBusy('bulk')" @click="runBulk('pause')">{{ t('queue.jobs.pause') }}</BaseButton>
              <BaseButton size="sm" variant="secondary" data-testid="bulk-resume" :disabled="queue.isBusy('bulk')" @click="runBulk('resume')">{{ t('queue.jobs.resume') }}</BaseButton>
              <BaseButton size="sm" variant="secondary" data-testid="bulk-retry" :disabled="queue.isBusy('bulk')" @click="runBulk('retry')">{{ t('queue.jobs.retry') }}</BaseButton>
              <BaseButton size="sm" variant="danger" data-testid="bulk-cancel" :disabled="queue.isBusy('bulk')" @click="runBulk('cancel')">{{ t('queue.jobs.cancel') }}</BaseButton>
              <BaseButton size="sm" variant="danger" data-testid="bulk-delete" :disabled="queue.isBusy('bulk')" @click="runBulk('delete')">{{ t('queue.rules.delete') }}</BaseButton>
              <BaseButton size="sm" variant="ghost" data-testid="bulk-clear" :disabled="queue.isBusy('bulk')" @click="clearSelection">{{ t('queue.summary.clear') }}</BaseButton>
            </div>
          </div>

          <div v-if="queue.loading && !queue.loaded" class="loading" data-testid="loading-state">
            {{ t('queue.pipeline.loading') }}
          </div>
          <div v-else-if="shownJobs.length === 0" class="empty" data-testid="empty-state">
            <template v-if="isPipelineV2 && activeList === 'live'">
              <b>{{ t('queue.pipeline.emptyLiveTitle') }}</b>
              <span>{{ t('queue.pipeline.emptyLiveDescription') }}</span>
            </template>
            <template v-else-if="isPipelineV2">
              <b>{{ t('queue.pipeline.emptyHistoryTitle') }}</b>
              <span>{{ t('queue.pipeline.emptyHistoryDescription') }}</span>
            </template>
            <template v-else>
              <b>{{ t('queue.pipeline.emptyLegacyTitle') }}</b>
              <span>{{ t('queue.pipeline.emptyLegacyDescription') }}</span>
            </template>
          </div>
          <div
            v-else
            class="job-list"
            data-testid="job-list"
            role="listbox"
            :aria-label="jobListLabel"
            @keydown="onJobListKeydown"
          >
            <div
              v-for="job in shownJobs"
              :key="job.id"
              class="job-row"
              :class="{ selected: selectedJob?.id === job.id, 'drag-over': dragOverId === job.id, dragging: dragId === job.id, fixed: !isReorderable(job) }"
              :data-status="job.status"
              :data-testid="`job-row-${job.id}`"
              role="option"
              :aria-selected="selectedJob?.id === job.id"
              :tabindex="selectedJob?.id === job.id ? 0 : -1"
              :draggable="isReorderable(job)"
              @click="selectedJobId = job.id"
              @dragstart="onDragStart(job, $event)"
              @dragover="onDragOver(job, $event)"
              @dragleave="onDragLeave(job)"
              @drop="onDrop(job, $event)"
              @dragend="onDragEnd"
            >
              <input
                v-if="!isPipelineV2 || activeList === 'live'"
                type="checkbox"
                class="job-check"
                :data-testid="`select-job-${job.id}`"
                :checked="isSelected(job.id)"
                @click.stop
                @change="toggleSelected(job.id)"
              />
              <span v-else class="job-check-spacer" />
              <span class="pos">{{ job.position }}</span>
              <span class="job-main">
                <span class="job-title">{{ jobTitle(job) }}</span>
                <span class="job-prompt">{{ shortPrompt(job) }}</span>
              </span>
              <span class="provider">{{ isPipelineV2 ? targetLabel(job.targetType) : providerLabel(job.provider) }}</span>
              <span class="pill" :class="statusClass(job.status)">{{ statusLabel(job.status) }}</span>
            </div>
          </div>
        </aside>

        <section v-if="selectedJob" class="detail" data-testid="job-detail">
          <div class="detail-head">
            <div>
              <h2>{{ jobTitle(selectedJob) }}</h2>
              <p>{{ selectedJob.workspacePath }}</p>
            </div>
            <span class="pill large" :class="statusClass(selectedJob.status)">{{ statusLabel(selectedJob.status) }}</span>
          </div>

          <div v-if="isPipelineV2" class="target-detail" data-testid="target-detail">
            <span><b>{{ t('queue.target.labelShort') }}</b> {{ targetLabel(selectedJob.targetType) }}</span>
            <span><b>{{ t('queue.target.reference') }}</b> {{ targetRefText(selectedJob) }}</span>
          </div>

          <div v-if="selectedJob.status === 'blocked_by_limit'" class="blocked-detail" data-testid="selected-blocked">
            <b>{{ selectedJob.blockedReason ?? t('queue.summary.blockedByRule') }}</b>
            <span>{{ t('queue.jobs.expectedResume', { time: formatTime(selectedJob.resumeAfter) }) }}</span>
            <span>{{ t('queue.jobs.countdown', { time: countdown(selectedJob.resumeAfter) }) }}</span>
          </div>

          <div v-if="selectedJob.status === 'failed'" class="failure-detail" data-testid="failure-detail">
            <b>{{ failureReason(selectedJob) }}</b>
            <span>{{ t('queue.jobs.attemptsDetail', { target: targetLabel(selectedJob.targetType), attempts: selectedJob.attempts, max: selectedJob.maxAttempts }) }}</span>
            <span>{{ t('queue.jobs.nextAction', { action: isPipelineV2 && activeList === 'history' ? t('queue.jobs.retryAsNewAction') : t('queue.jobs.retryAction') }) }}</span>
          </div>

          <div v-if="isPipelineV2 && activeList === 'history'" class="controls" :aria-label="t('queue.history.controls')">
            <BaseButton
              size="sm"
              variant="secondary"
              data-testid="retry-as-new-job"
              :loading="queue.isBusy('enqueue')"
              @click="retryAsNew(selectedJob)"
            >
              {{ t('queue.history.retryAsNew') }}
            </BaseButton>
            <BaseButton
              size="sm"
              variant="danger"
              data-testid="archive-history-job"
              :loading="queue.isBusy('bulk')"
              @click="archiveHistoryJob(selectedJob)"
            >
              {{ t('queue.history.archive') }}
            </BaseButton>
          </div>

          <div v-else class="controls" :aria-label="t('queue.jobs.controls')">
            <BaseButton size="sm" variant="secondary" data-testid="move-up-job" :disabled="queue.isBusy('reorder') || !isReorderable(selectedJob)" @click="moveSelected(-1)">{{ t('queue.jobs.moveUp') }}</BaseButton>
            <BaseButton size="sm" variant="secondary" data-testid="move-down-job" :disabled="queue.isBusy('reorder') || !isReorderable(selectedJob)" @click="moveSelected(1)">{{ t('queue.jobs.moveDown') }}</BaseButton>
            <BaseButton
              size="sm"
              variant="secondary"
              data-testid="pause-job"
              :loading="queue.isBusy(`pause:${selectedJob.id}`)"
              :disabled="!canPause(selectedJob)"
              @click="runControl('pause')"
            >
              {{ t('queue.jobs.pause') }}
            </BaseButton>
            <BaseButton
              size="sm"
              variant="secondary"
              data-testid="resume-job"
              :loading="queue.isBusy(`resume:${selectedJob.id}`)"
              :disabled="!canResume(selectedJob)"
              @click="runControl('resume')"
            >
              {{ t('queue.jobs.resume') }}
            </BaseButton>
            <BaseButton
              size="sm"
              variant="secondary"
              data-testid="retry-job"
              :loading="queue.isBusy(`retry:${selectedJob.id}`)"
              :disabled="!canRetry(selectedJob)"
              @click="runControl('retry')"
            >
              {{ t('queue.jobs.retry') }}
            </BaseButton>
            <BaseButton
              size="sm"
              variant="danger"
              data-testid="cancel-job"
              :loading="queue.isBusy(`cancel:${selectedJob.id}`)"
              :disabled="isTerminal(selectedJob.status)"
              @click="runControl('cancel')"
            >
              {{ t('queue.jobs.cancel') }}
            </BaseButton>
          </div>

          <div class="detail-grid">
            <section class="timeline" data-testid="step-timeline">
              <div class="panel-head">
                <b>{{ t('queue.jobs.stepTimeline') }}</b>
                <span>{{ progressFor(selectedJob).completed }}/{{ progressFor(selectedJob).total }}</span>
              </div>
              <div v-if="selectedJob.steps.length === 0" class="empty small">
                <span>{{ t('queue.jobs.noTigerStages') }}</span>
              </div>
              <ol v-else>
                <li v-for="step in selectedJob.steps" :key="step.id" :class="statusClass(step.status)">
                  <span class="step-dot" />
                  <span class="step-main">
                    <b>{{ step.stepKey }}</b>
                    <small>
                      {{ statusLabel(step.status) }}
                      <template v-if="step.attempts">{{ t('queue.jobs.stepAttempt', { n: step.attempts }) }}</template>
                    </small>
                    <em v-if="step.error">{{ step.error }}</em>
                  </span>
                  <time>{{ formatTime(step.updatedAt) }}</time>
                </li>
              </ol>
            </section>

            <section class="events" data-testid="event-log">
              <div class="panel-head">
                <b>{{ t('queue.jobs.logsAndEvents') }}</b>
                <span>{{ selectedEvents.length }}</span>
              </div>
              <div v-if="selectedEvents.length === 0" class="empty small">
                <span>{{ t('queue.jobs.waitingEvents') }}</span>
              </div>
              <ul v-else>
                <li v-for="event in selectedEvents" :key="event.id">
                  <time>{{ formatTime(event.createdAt) }}</time>
                  <b>{{ event.type }}</b>
                  <span>{{ event.message }}</span>
                </li>
              </ul>
            </section>
          </div>
        </section>

        <section v-else class="detail empty-detail">
          <div class="empty">
            <b>{{ t('queue.jobs.selectJobTitle') }}</b>
            <span>{{ t('queue.jobs.selectJobDescription') }}</span>
          </div>
        </section>
      </section>
    </main>
  </div>
</template>

<style scoped>
.queue-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.qhead {
  height: var(--bar-h);
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
}
.brand b {
  font-size: 15px;
}
.sub,
.updated {
  color: var(--text-dim);
  font-size: 12px;
}
.spacer {
  flex: 1;
}
.conn {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--slate);
}
.conn.connected {
  background: var(--green);
  box-shadow: 0 0 8px var(--green);
}
.conn.connecting {
  background: var(--amber);
}
.conn.disconnected {
  background: var(--red);
}
.qbody {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.banner {
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 9px 12px;
  color: var(--text-dim);
  background: var(--bg-elev);
  font-size: 13px;
}
.banner.error {
  color: var(--red);
  border-color: var(--red);
}
.banner.disconnected,
.banner.recovery {
  color: var(--amber);
  border-color: var(--amber);
}
.summary {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
}
.lanes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.lane {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 700;
}
.lane.full {
  color: var(--amber);
  border-color: var(--amber);
}
.target-tabs,
.queue-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}
.queue-tabs {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.target-tabs button,
.queue-tabs button {
  min-height: 32px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  background: var(--bg);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.target-tabs button.active,
.queue-tabs button.active {
  color: var(--text);
  border-color: var(--accent);
  background: var(--bg-elev-2);
}
.target-tabs button:focus-visible,
.queue-tabs button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.select-all {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.select-all input {
  width: 15px;
  height: 15px;
}
.bulk-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev-2);
}
.bulk-count {
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 700;
}
.bulk-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-left: auto;
}
.rule-editor {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
}
.rule-editor-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.rule-editor-head div {
  display: grid;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.rule-editor-head span,
.rule-card span {
  color: var(--text-dim);
  font-size: 12px;
}
.rule-form {
  display: grid;
  grid-template-columns: minmax(160px, 1.3fr) 112px minmax(96px, 0.75fr) 96px 112px 98px auto;
  gap: 10px;
  align-items: end;
}
.rule-enabled {
  min-height: 54px;
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.rule-enabled input {
  width: 16px;
  height: 16px;
}
.rule-list {
  display: grid;
  gap: 8px;
}
.rule-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
}
.rule-card div {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.rule-card b,
.rule-card span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.metric {
  min-height: 116px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
}
.metric.hot {
  border-color: var(--amber);
}
.label {
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}
.metric b {
  font-size: 15px;
}
.meta,
.eta {
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.4;
}
.eta {
  color: var(--amber);
}
.progress {
  height: 7px;
  border-radius: var(--radius-sm);
  background: var(--bg);
  overflow: hidden;
  border: 1px solid var(--border);
}
.progress span {
  display: block;
  height: 100%;
  min-width: 3px;
  background: var(--green);
}
.content {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(360px, 420px) minmax(0, 1fr);
  gap: 12px;
}
.left,
.detail {
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
}
.left {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.enqueue {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--border);
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 120px;
  gap: 10px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
label span {
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 700;
}
textarea {
  min-height: 112px;
  resize: vertical;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.45;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 9px 10px;
}
.list-head,
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.list-head span,
.panel-head span {
  color: var(--text-faint);
  font-size: 12px;
}
.loading,
.empty {
  display: grid;
  gap: 6px;
  place-items: center;
  padding: 24px 14px;
  color: var(--text-dim);
  text-align: center;
}
.empty span {
  color: var(--text-faint);
  font-size: 13px;
}
.empty.small {
  padding: 18px 10px;
}
.job-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
}
.job-row {
  width: 100%;
  display: grid;
  grid-template-columns: 22px 28px minmax(0, 1fr) 58px 112px;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 0;
  border-radius: 0;
  border-bottom: 1px solid var(--border);
  text-align: left;
  cursor: pointer;
}
.job-row:not(.fixed) {
  cursor: grab;
}
.job-row:hover,
.job-row.selected {
  background: var(--bg-elev-2);
}
.job-row.selected {
  box-shadow: inset 3px 0 0 var(--accent);
}
.job-row.dragging {
  opacity: 0.5;
}
.job-row.drag-over {
  box-shadow: inset 0 2px 0 var(--accent);
}
.job-check {
  width: 15px;
  height: 15px;
}
.job-check-spacer {
  width: 15px;
  height: 15px;
}
.pos {
  font-family: var(--font-mono);
  color: var(--text-faint);
  font-size: 12px;
}
.job-main {
  min-width: 0;
  display: grid;
  gap: 4px;
}
.job-title {
  color: var(--text);
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.job-prompt {
  color: var(--text-faint);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.provider {
  color: var(--text-dim);
  font-size: 11px;
}
.pill {
  justify-self: end;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 92px;
  padding: 3px 8px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}
.pill.large {
  min-width: 130px;
  padding: 5px 10px;
}
.s-running,
.s-retrying {
  color: var(--accent);
  border-color: var(--accent);
}
.s-completed {
  color: var(--green);
  border-color: var(--green);
}
.s-blocked_by_limit,
.s-paused {
  color: var(--amber);
  border-color: var(--amber);
}
.s-failed,
.s-canceled {
  color: var(--red);
  border-color: var(--red);
}
.detail {
  overflow: auto;
  padding: 14px;
}
.detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.detail h2 {
  margin: 0 0 5px;
  font-size: 18px;
}
.detail p {
  margin: 0;
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.blocked-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--amber);
  border-radius: var(--radius-sm);
  color: var(--amber);
  background: var(--amber-soft);
}
.blocked-detail span {
  color: var(--text-dim);
  font-size: 12px;
}
.target-detail,
.failure-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text-dim);
  font-size: 12px;
}
.target-detail span,
.failure-detail span,
.target-detail b,
.failure-detail b {
  overflow-wrap: anywhere;
}
.failure-detail {
  color: var(--amber);
  border-color: var(--amber);
  background: var(--amber-soft);
}
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}
.detail-grid {
  display: grid;
  grid-template-columns: minmax(340px, 0.95fr) minmax(300px, 1.05fr);
  gap: 12px;
}
.timeline,
.events {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.timeline ol,
.events ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.timeline li {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) minmax(120px, auto);
  gap: 9px;
  align-items: start;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.timeline li:last-child,
.events li:last-child {
  border-bottom: 0;
}
.step-dot {
  width: 9px;
  height: 9px;
  margin-top: 4px;
  border-radius: 50%;
  border: 1px solid currentColor;
  background: currentColor;
}
.step-main {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.step-main b {
  font-size: 13px;
}
.step-main small,
.step-main em,
.timeline time,
.events time {
  color: var(--text-faint);
  font-size: 11px;
}
.step-main em {
  overflow-wrap: anywhere;
  font-style: normal;
  color: var(--amber);
}
.timeline time {
  text-align: right;
}
.events li {
  display: grid;
  grid-template-columns: 145px 150px minmax(0, 1fr);
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.events b {
  color: var(--text-dim);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.events span {
  color: var(--text);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.empty-detail {
  display: grid;
  place-items: center;
}
@media (max-width: 1180px) {
  .summary,
  .rule-form,
  .content,
  .detail-grid {
    grid-template-columns: 1fr;
  }
  .left {
    max-height: none;
  }
}
@media (max-width: 720px) {
  .qhead {
    height: auto;
    min-height: var(--bar-h);
    flex-wrap: wrap;
    padding: 10px 12px;
  }
  .updated {
    display: none;
  }
  .job-row {
    grid-template-columns: 22px 26px minmax(0, 1fr);
  }
  .provider,
  .job-row .pill {
    justify-self: start;
  }
  .events li,
  .timeline li,
  .rule-card {
    grid-template-columns: 1fr;
  }
  .timeline time {
    text-align: left;
  }
}
</style>
