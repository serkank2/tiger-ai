<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useSocket } from '~/composables/useSocket';
import { useConnectionStore } from '~/stores/connection';
import { useQueueStore } from '~/stores/queue';
import type {
  QueueJobStatus,
  QueueJobView,
  QueueProvider,
  QueueRule,
  QueueRuleOperator,
  QueueRuleProvider,
  QueueState,
  QueueStepStatus,
} from '~/types';

withDefaults(defineProps<{ showHeader?: boolean }>(), { showHeader: false });
const emit = defineEmits<{ back: [] }>();

const queue = useQueueStore();
const conn = useConnectionStore();
const socket = useSocket();

const selectedJobId = ref<string | null>(null);
const nowMs = ref(Date.now());
const draft = reactive({
  projectName: '',
  workspacePath: '',
  prompt: '',
  provider: 'claude' as QueueProvider,
  priority: 0,
  maxAttempts: 1,
});
const ruleDraft = reactive({
  name: 'Claude usage >= 90%',
  provider: 'claude' as QueueRuleProvider,
  windowKey: 'any',
  operator: 'gte' as QueueRuleOperator,
  threshold: 90,
  enabled: true,
});
const editingRuleId = ref<string | null>(null);

const ruleProviders: QueueRuleProvider[] = ['claude', 'codex', 'mixed', 'any'];
const ruleOperators: QueueRuleOperator[] = ['gte', 'gt', 'lte', 'lt', 'eq'];

let clock: ReturnType<typeof setInterval> | null = null;
let unsubscribeQueueState: (() => void) | null = null;

const jobs = computed(() => queue.jobs);
const selectedJob = computed(() => jobs.value.find((job) => job.id === selectedJobId.value) ?? jobs.value[0] ?? null);
const activeProgress = computed(() => progressFor(queue.activeJob));
const enabledRules = computed(() => queue.rules.filter((rule) => rule.enabled));
const disabledRules = computed(() => queue.rules.filter((rule) => !rule.enabled));
const savingRule = computed(() =>
  queue.isBusy(editingRuleId.value ? `rule:update:${editingRuleId.value}` : 'rule:create'),
);
const canSaveRule = computed(
  () => ruleDraft.name.trim().length > 0 && Number.isFinite(ruleDraft.threshold) && ruleDraft.threshold >= 0 && ruleDraft.threshold <= 100 && !savingRule.value,
);
const canSubmit = computed(() => draft.prompt.trim().length > 0 && !queue.isBusy('enqueue'));
const selectedEvents = computed(() => {
  const job = selectedJob.value;
  if (!job) return queue.events.slice(0, 30);
  return queue.events.filter((event) => event.jobId === job.id || event.jobId === null).slice(0, 30);
});

const hasRecovery = computed(() => jobs.value.some(isRecoveryJob));

watch(
  jobs,
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
  if (provider === 'codex') return 'Codex';
  if (provider === 'mixed') return 'Mixed';
  return 'Claude';
}

function ruleLabel(rule: { provider: string; windowKey: string; operator: string; threshold: number }): string {
  const op = rule.operator === 'gte' ? '>=' : rule.operator === 'lte' ? '<=' : rule.operator;
  return `${rule.provider} ${rule.windowKey} ${op} ${rule.threshold}%`;
}

function jobTitle(job: QueueJobView): string {
  return job.projectName?.trim() || `Job ${job.id.slice(0, 8)}`;
}

function shortPrompt(job: QueueJobView): string {
  const prompt = job.prompt.replace(/\s+/g, ' ').trim();
  return prompt.length > 140 ? `${prompt.slice(0, 137)}...` : prompt;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return 'Not set';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toLocaleString();
}

function countdown(iso: string | null): string {
  if (!iso) return 'Waiting for a fresh limit snapshot';
  const ms = new Date(iso).getTime() - nowMs.value;
  if (!Number.isFinite(ms) || ms <= 0) return 'Ready to resume';
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
    await queue.enqueue({
      prompt: draft.prompt.trim(),
      projectName: draft.projectName.trim() || undefined,
      workspacePath: draft.workspacePath.trim() || undefined,
      provider: draft.provider,
      priority: Number.isFinite(draft.priority) ? draft.priority : 0,
      maxAttempts: Number.isFinite(draft.maxAttempts) && draft.maxAttempts > 0 ? draft.maxAttempts : 1,
    });
    draft.prompt = '';
    draft.projectName = '';
    draft.workspacePath = '';
    draft.priority = 0;
    draft.maxAttempts = 1;
  } catch {
    /* surfaced through queue.actionError */
  }
}

function resetRuleDraft(): void {
  editingRuleId.value = null;
  Object.assign(ruleDraft, {
    name: 'Claude usage >= 90%',
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
  if (!job || queue.isBusy('reorder')) return;
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
  if (!job) return;
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
        <b>Queue</b>
        <span class="sub">Autonomous prompt execution</span>
        <span class="conn" :class="conn.status" :title="`backend ${conn.status}`" />
      </div>
      <span class="spacer" />
      <span v-if="queue.updatedAt" class="updated">Synced {{ formatTime(queue.updatedAt) }}</span>
      <button class="head-btn" data-testid="refresh-queue" :disabled="queue.loading" @click="queue.load().catch(() => {})">
        Refresh
      </button>
      <button class="head-btn" @click="emit('back')">Back to terminals</button>
    </header>

    <main class="qbody">
      <div v-if="conn.status !== 'connected'" class="banner disconnected" data-testid="disconnected-banner">
        Live connection is {{ conn.status }}. REST refresh remains available; WebSocket updates will reconcile on reconnect.
      </div>
      <div v-if="queue.loadError" class="banner error" data-testid="error-banner">
        {{ queue.loadError }}
      </div>
      <div v-if="queue.actionError" class="banner error" data-testid="action-error">
        {{ queue.actionError }}
      </div>
      <div v-if="hasRecovery" class="banner recovery" data-testid="recovery-banner">
        A recovered job is retrying after a backend restart. Completed steps stay completed.
      </div>

      <section class="summary">
        <div class="metric active-panel" data-testid="active-panel">
          <span class="label">Active</span>
          <template v-if="queue.activeJob">
            <b>{{ jobTitle(queue.activeJob) }}</b>
            <span class="meta">
              {{ queue.activeJob.currentStep ?? 'Starting' }} -
              {{ activeProgress.completed }}/{{ activeProgress.total }} steps
            </span>
            <div class="progress" aria-label="Active job progress">
              <span :style="{ width: `${activeProgress.percent}%` }" />
            </div>
          </template>
          <template v-else>
            <b>No active job</b>
            <span class="meta">{{ queue.dispatchableJobs.length }} ready, {{ queue.pausedJobs.length }} paused</span>
          </template>
        </div>

        <div class="metric blocked-panel" :class="{ hot: queue.blockedJobs.length > 0 }" data-testid="blocked-panel">
          <span class="label">Blocked by limit</span>
          <template v-if="queue.blockedJobs.length">
            <b>{{ queue.blockedJobs.length }} job(s)</b>
            <span class="meta">{{ queue.blockedJobs[0]?.blockedReason ?? 'Blocked by active queue rule' }}</span>
            <span class="eta">Resume {{ countdown(queue.blockedJobs[0]?.resumeAfter ?? null) }}</span>
          </template>
          <template v-else>
            <b>Clear</b>
            <span class="meta">No job is blocked by current limit rules</span>
          </template>
        </div>

        <div class="metric rules-panel" data-testid="rules-panel">
          <span class="label">Rules</span>
          <b>{{ enabledRules.length }} enabled</b>
          <span class="meta" v-if="enabledRules[0]">{{ enabledRules.map(ruleLabel).join(', ') }}</span>
          <span class="meta" v-else>No enabled queue dispatch rules</span>
          <span v-if="disabledRules.length" class="eta">{{ disabledRules.length }} disabled</span>
        </div>
      </section>

      <section class="rule-editor" data-testid="rule-editor">
        <div class="rule-editor-head">
          <div>
            <b>Queue rule management</b>
            <span>Block dispatch from current provider usage and resume at the reset time.</span>
          </div>
          <button type="button" :disabled="!editingRuleId || savingRule" @click="resetRuleDraft">New rule</button>
        </div>

        <form class="rule-form" data-testid="rule-form" @submit.prevent="saveRule">
          <label>
            <span>Name</span>
            <input v-model="ruleDraft.name" data-testid="rule-name" placeholder="Rule name" maxlength="191" />
          </label>
          <label>
            <span>Provider</span>
            <select v-model="ruleDraft.provider" data-testid="rule-provider">
              <option v-for="item in ruleProviders" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <label>
            <span>Window</span>
            <input v-model="ruleDraft.windowKey" data-testid="rule-window" placeholder="any" />
          </label>
          <label>
            <span>Operator</span>
            <select v-model="ruleDraft.operator" data-testid="rule-operator">
              <option v-for="item in ruleOperators" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <label>
            <span>Threshold</span>
            <input v-model.number="ruleDraft.threshold" data-testid="rule-threshold" type="number" min="0" max="100" step="0.1" />
          </label>
          <label class="rule-enabled">
            <input v-model="ruleDraft.enabled" data-testid="rule-enabled" type="checkbox" />
            <span>Enabled</span>
          </label>
          <button class="primary" data-testid="save-rule" type="submit" :disabled="!canSaveRule">
            {{ savingRule ? 'Saving...' : editingRuleId ? 'Update rule' : 'Create rule' }}
          </button>
        </form>

        <div v-if="queue.rules.length" class="rule-list" data-testid="rule-list">
          <article v-for="rule in queue.rules" :key="rule.id" class="rule-card">
            <div>
              <b>{{ rule.name }}</b>
              <span>{{ ruleLabel(rule) }} / {{ rule.enabled ? 'enabled' : 'disabled' }}</span>
            </div>
            <button type="button" data-testid="edit-rule" @click="editRule(rule)">Edit</button>
            <button
              type="button"
              class="danger"
              data-testid="delete-rule"
              :disabled="queue.isBusy(`rule:delete:${rule.id}`)"
              @click="deleteRule(rule)"
            >
              Delete
            </button>
          </article>
        </div>
      </section>

      <section class="content">
        <aside class="left">
          <form class="enqueue" data-testid="enqueue-form" @submit.prevent="submitEnqueue">
            <div class="form-grid">
              <label>
                <span>Project</span>
                <input v-model="draft.projectName" data-testid="enqueue-project" placeholder="Optional project name" />
              </label>
              <label>
                <span>Provider</span>
                <select v-model="draft.provider" data-testid="enqueue-provider">
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                  <option value="mixed">Mixed</option>
                </select>
              </label>
              <label>
                <span>Priority</span>
                <input v-model.number="draft.priority" data-testid="enqueue-priority" type="number" step="1" />
              </label>
              <label>
                <span>Attempts</span>
                <input v-model.number="draft.maxAttempts" data-testid="enqueue-attempts" type="number" min="1" step="1" />
              </label>
            </div>
            <label>
              <span>Workspace</span>
              <input v-model="draft.workspacePath" data-testid="enqueue-workspace" placeholder="Optional absolute path" />
            </label>
            <label>
              <span>Prompt</span>
              <textarea
                v-model="draft.prompt"
                data-testid="enqueue-prompt"
                rows="5"
                placeholder="Write the autonomous prompt to run..."
              />
            </label>
            <button class="primary" data-testid="enqueue-submit" type="submit" :disabled="!canSubmit">
              {{ queue.isBusy('enqueue') ? 'Enqueuing...' : 'Enqueue' }}
            </button>
          </form>

          <div class="list-head">
            <b>Ordered jobs</b>
            <span>{{ jobs.length }} total</span>
          </div>

          <div v-if="queue.loading && !queue.loaded" class="loading" data-testid="loading-state">
            Loading queue...
          </div>
          <div v-else-if="jobs.length === 0" class="empty" data-testid="empty-state">
            <b>No queued jobs</b>
            <span>Submit a prompt to start sequential autonomous execution.</span>
          </div>
          <div v-else class="job-list" data-testid="job-list">
            <button
              v-for="job in jobs"
              :key="job.id"
              type="button"
              class="job-row"
              :class="{ selected: selectedJob?.id === job.id }"
              :data-status="job.status"
              @click="selectedJobId = job.id"
            >
              <span class="pos">{{ job.position }}</span>
              <span class="job-main">
                <span class="job-title">{{ jobTitle(job) }}</span>
                <span class="job-prompt">{{ shortPrompt(job) }}</span>
              </span>
              <span class="provider">{{ providerLabel(job.provider) }}</span>
              <span class="pill" :class="statusClass(job.status)">{{ statusLabel(job.status) }}</span>
            </button>
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

          <div v-if="selectedJob.status === 'blocked_by_limit'" class="blocked-detail" data-testid="selected-blocked">
            <b>{{ selectedJob.blockedReason ?? 'Blocked by an active limit rule.' }}</b>
            <span>Expected resume: {{ formatTime(selectedJob.resumeAfter) }}</span>
            <span>Countdown: {{ countdown(selectedJob.resumeAfter) }}</span>
          </div>

          <div class="controls" aria-label="Queue job controls">
            <button data-testid="move-up-job" :disabled="queue.isBusy('reorder')" @click="moveSelected(-1)">Move up</button>
            <button data-testid="move-down-job" :disabled="queue.isBusy('reorder')" @click="moveSelected(1)">Move down</button>
            <button
              data-testid="pause-job"
              :disabled="!canPause(selectedJob) || queue.isBusy(`pause:${selectedJob.id}`)"
              @click="runControl('pause')"
            >
              Pause
            </button>
            <button
              data-testid="resume-job"
              :disabled="!canResume(selectedJob) || queue.isBusy(`resume:${selectedJob.id}`)"
              @click="runControl('resume')"
            >
              Resume
            </button>
            <button
              data-testid="retry-job"
              :disabled="!canRetry(selectedJob) || queue.isBusy(`retry:${selectedJob.id}`)"
              @click="runControl('retry')"
            >
              Retry
            </button>
            <button
              class="danger"
              data-testid="cancel-job"
              :disabled="isTerminal(selectedJob.status) || queue.isBusy(`cancel:${selectedJob.id}`)"
              @click="runControl('cancel')"
            >
              Cancel
            </button>
          </div>

          <div class="detail-grid">
            <section class="timeline" data-testid="step-timeline">
              <div class="panel-head">
                <b>Step timeline</b>
                <span>{{ progressFor(selectedJob).completed }}/{{ progressFor(selectedJob).total }}</span>
              </div>
              <ol>
                <li v-for="step in selectedJob.steps" :key="step.id" :class="statusClass(step.status)">
                  <span class="step-dot" />
                  <span class="step-main">
                    <b>{{ step.stepKey }}</b>
                    <small>
                      {{ statusLabel(step.status) }}
                      <template v-if="step.attempts">- attempt {{ step.attempts }}</template>
                    </small>
                    <em v-if="step.error">{{ step.error }}</em>
                  </span>
                  <time>{{ formatTime(step.updatedAt) }}</time>
                </li>
              </ol>
            </section>

            <section class="events" data-testid="event-log">
              <div class="panel-head">
                <b>Logs and events</b>
                <span>{{ selectedEvents.length }}</span>
              </div>
              <div v-if="selectedEvents.length === 0" class="empty small">
                <span>Waiting for queue state changes.</span>
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
            <b>Select a queue job</b>
            <span>Job controls, timeline, and logs appear here.</span>
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
.head-btn,
.controls button,
.primary {
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
  padding: 7px 12px;
  font-weight: 600;
}
.head-btn:hover:not(:disabled),
.controls button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
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
.rule-editor-head button,
.rule-card button {
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
  padding: 6px 10px;
  font-weight: 600;
}
.rule-editor-head button:hover:not(:disabled),
.rule-card button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
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
.rule-card .danger {
  border-color: var(--red);
  color: var(--red);
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
.primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--bg);
}
.primary:hover:not(:disabled) {
  background: var(--accent-strong);
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
  grid-template-columns: 32px minmax(0, 1fr) 58px 112px;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 0;
  border-radius: 0;
  border-bottom: 1px solid var(--border);
  text-align: left;
}
.job-row:hover,
.job-row.selected {
  background: var(--bg-elev-2);
}
.job-row.selected {
  box-shadow: inset 3px 0 0 var(--accent);
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
  background: rgba(224, 176, 58, 0.08);
}
.blocked-detail span {
  color: var(--text-dim);
  font-size: 12px;
}
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}
.controls .danger {
  border-color: var(--red);
  color: var(--red);
}
.controls .danger:hover:not(:disabled) {
  background: rgba(229, 86, 75, 0.12);
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
    grid-template-columns: 26px minmax(0, 1fr);
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
