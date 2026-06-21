<script setup lang="ts">
import { computed, onBeforeUnmount, onErrorCaptured, onMounted, ref, watch } from 'vue';
import Skeleton from '~/components/ui/Skeleton.vue';
import LimitStatusBadge from '~/components/shell/LimitStatusBadge.vue';
import { useSocket } from '~/composables/useSocket';
import { useConnectionStore } from '~/stores/connection';
import { useLimitsStore } from '~/stores/limits';
import { useQueueStore } from '~/stores/queue';
import {
  gateLabel,
  isSnapshotStale,
  normalizedPercent,
  percentText,
  severityForPercent,
  sortSnapshotsNewestFirst,
} from '~/lib/limits';
import type { LimitSnapshot, LimitStatus, QueueProvider, QueueState, TigerAgentType } from '~/types';

const PROVIDERS: TigerAgentType[] = ['claude', 'codex', 'antigravity'];
const QUEUE_PROVIDERS: QueueProvider[] = ['claude', 'codex', 'antigravity', 'mixed'];
const SPARKLINE_WIDTH = 96;
const SPARKLINE_HEIGHT = 30;

const labels: Record<TigerAgentType | QueueProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
  mixed: 'Mixed',
};

const limits = useLimitsStore();
const queue = useQueueStore();
const conn = useConnectionStore();
const socket = useSocket();

const nowMs = ref(Date.now());
const panelError = ref<string | null>(null);

let clock: ReturnType<typeof setInterval> | null = null;
let unsubscribeLimitState: (() => void) | null = null;
let unsubscribeQueueState: (() => void) | null = null;

onErrorCaptured((error) => {
  panelError.value = error instanceof Error ? error.message : 'Limit panel failed.';
  return false;
});

const loading = computed(() => !limits.loaded && !limits.loadError);

const freshnessLabel = computed(() => {
  if (conn.status === 'disconnected') return 'Disconnected';
  if (limits.stale) return 'Stale';
  if (!limits.hasData) return 'No snapshots';
  return 'Fresh';
});

const gate = computed(() => limits.decision);
const gateState = computed(() => (gate.value?.action === 'block' ? 'blocked' : 'allowed'));
const firstBlockedJob = computed(() => queue.blockedJobs[0] ?? null);

const lanes = computed(() => {
  const running = queue.state?.runningByProvider;
  const concurrency = queue.state?.providerConcurrency;
  if (!running || !concurrency) return [];
  return QUEUE_PROVIDERS.map((provider) => {
    const active = running[provider] ?? 0;
    const limit = concurrency[provider] ?? 0;
    return {
      provider,
      label: labels[provider],
      active,
      limit,
      full: limit > 0 && active >= limit,
    };
  });
});

const providerCards = computed(() =>
  PROVIDERS.map((provider) => {
    const backend = limits.providers?.[provider];
    const latest = sortedByWindow(backend?.latest?.length ? backend.latest : limits.latest.filter((item) => item.provider === provider));
    const current = currentSnapshot(latest);
    const maxPercent = normalizedPercent(current?.percentUsed);
    const unsupported = unsupportedMessage(provider, latest, backend?.error);
    const stale = latest.some((snapshot) => isSnapshotStale(snapshot, limits.staleAfterMs, nowMs.value));
    const errored = latest.some((snapshot) => !snapshot.ok || !!snapshot.error) || !!backend?.error;
    const status = providerStatus({
      latest,
      maxPercent,
      stale,
      errored,
      unsupported,
      provider,
    });
    const series = sparklineSeries(provider, current?.windowKey ?? latest[0]?.windowKey ?? null);

    return {
      provider,
      label: labels[provider],
      latest,
      current,
      maxPercent,
      percentLabel: unsupported ? 'Unsupported' : percentText(maxPercent),
      resetLabel: resetLabel(current),
      checkedLabel: checkedLabel(backend?.latestCheckedAt ?? current?.checkedAt ?? null),
      status,
      statusLabel: statusLabel(status),
      unsupported,
      message: unsupported ?? backend?.error ?? latest.find((item) => item.error)?.error ?? null,
      sparklinePoints: sparklinePoints(series),
      sparklineCount: series.length,
      windows: latest.map((snapshot) => ({
        snapshot,
        percent: normalizedPercent(snapshot.percentUsed),
        percentLabel: percentText(snapshot.percentUsed),
        width: `${normalizedPercent(snapshot.percentUsed) ?? 0}%`,
        stale: isSnapshotStale(snapshot, limits.staleAfterMs, nowMs.value),
        severity: severityForPercent(snapshot.percentUsed),
      })),
    };
  }),
);

function hydrateLimits(): void {
  if (!limits.loaded && !limits.loading) void limits.load().catch(() => {});
}

function hydrateQueue(): void {
  if (!queue.loaded && !queue.loading) void queue.load({ quiet: true }).catch(() => {});
}

onMounted(() => {
  hydrateLimits();
  hydrateQueue();
  unsubscribeLimitState = socket.onServerEvent('limit.state', (msg) => {
    const state = (msg as unknown as { state?: LimitStatus }).state;
    if (state) limits.applyState(state);
  });
  unsubscribeQueueState = socket.onServerEvent('queue.state', (msg) => {
    const state = (msg as unknown as { state?: QueueState }).state;
    if (state) queue.applyState(state);
  });
  clock = setInterval(() => {
    nowMs.value = Date.now();
  }, 1000);
});

watch(
  () => conn.status,
  (status) => {
    if (status === 'connected') {
      hydrateLimits();
      hydrateQueue();
    }
  },
);

onBeforeUnmount(() => {
  if (clock) clearInterval(clock);
  unsubscribeLimitState?.();
  unsubscribeQueueState?.();
});

function refresh(): void {
  void limits.refresh().catch(() => {});
}

function openDetails(): void {
  void navigateTo('/limits');
}

function providerStatus(input: {
  latest: LimitSnapshot[];
  maxPercent: number | null;
  stale: boolean;
  errored: boolean;
  unsupported: string | null;
  provider: TigerAgentType;
}): string {
  if (input.unsupported) return 'unsupported';
  if (!input.latest.length) return 'empty';
  if (input.errored) return 'error';
  if (gate.value?.action === 'block' && gate.value.selectedWindow?.provider === input.provider) return 'blocked';
  if (input.stale) return 'stale';
  const severity = severityForPercent(input.maxPercent);
  if (severity === 'red') return 'red';
  if (severity === 'amber') return 'amber';
  if (severity === 'ok') return 'healthy';
  return 'unknown';
}

function statusLabel(status: string): string {
  if (status === 'healthy') return 'Healthy';
  if (status === 'amber') return 'Warn';
  if (status === 'red') return 'High';
  if (status === 'blocked') return 'Blocked';
  if (status === 'stale') return 'Stale';
  if (status === 'error') return 'Error';
  if (status === 'unsupported') return 'Unsupported';
  if (status === 'empty') return 'Empty';
  return 'Unknown';
}

function sortedByWindow(snapshots: LimitSnapshot[]): LimitSnapshot[] {
  return [...snapshots].sort((a, b) => {
    const aPercent = normalizedPercent(a.percentUsed) ?? -1;
    const bPercent = normalizedPercent(b.percentUsed) ?? -1;
    return bPercent - aPercent || a.label.localeCompare(b.label);
  });
}

function currentSnapshot(snapshots: LimitSnapshot[]): LimitSnapshot | null {
  return snapshots[0] ?? null;
}

function unsupportedMessage(provider: TigerAgentType, latest: LimitSnapshot[], backendError?: string): string | null {
  if (provider !== 'antigravity') return null;
  const snapshotError = latest.find((snapshot) => snapshot.error)?.error;
  const message = backendError ?? snapshotError ?? '';
  const lower = message.toLowerCase();
  if (lower.includes('unsupported') || lower.includes('no usage') || lower.includes('no limit') || lower.includes('agy')) {
    return message || 'Antigravity usage limits are unsupported by the CLI.';
  }
  if (!latest.length) return 'Antigravity usage limits are unsupported by the CLI.';
  if (latest.every((snapshot) => !snapshot.ok && normalizedPercent(snapshot.percentUsed) === null)) {
    return message || 'Antigravity usage limits are unsupported by the CLI.';
  }
  return null;
}

function sparklineSeries(provider: TigerAgentType, windowKey: string | null): number[] {
  const items = limits.snapshots
    .filter((snapshot) => snapshot.provider === provider)
    .filter((snapshot) => !windowKey || snapshot.windowKey === windowKey)
    .filter((snapshot) => snapshot.ok && normalizedPercent(snapshot.percentUsed) !== null)
    .sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt))
    .slice(-12);
  return items.map((snapshot) => normalizedPercent(snapshot.percentUsed)).filter((value): value is number => value !== null);
}

function sparklinePoints(values: number[]): string {
  if (values.length < 2) return '';
  const last = values.length - 1;
  return values
    .map((value, index) => {
      const x = (index / last) * SPARKLINE_WIDTH;
      const y = SPARKLINE_HEIGHT - (value / 100) * (SPARKLINE_HEIGHT - 4) - 2;
      return `${roundCoord(x)},${roundCoord(y)}`;
    })
    .join(' ');
}

function roundCoord(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

function resetLabel(snapshot: LimitSnapshot | null): string {
  if (!snapshot) return 'Reset unknown';
  if (snapshot.resetAt) return `Reset ${countdown(snapshot.resetAt, 'unknown')}`;
  if (snapshot.resetText) return `Reset ${snapshot.resetText}`;
  return 'Reset unknown';
}

function checkedLabel(iso: string | null): string {
  if (!iso) return 'Not checked';
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 'Not checked';
  const diff = Math.max(0, nowMs.value - time);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(time).toLocaleDateString();
}

function countdown(iso: string | null | undefined, empty = 'waiting'): string {
  if (!iso) return empty;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return empty;
  const ms = time - nowMs.value;
  if (ms <= 0) return 'ready';
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function latestHistoryCount(provider: TigerAgentType): number {
  return sortSnapshotsNewestFirst(limits.snapshots.filter((snapshot) => snapshot.provider === provider)).length;
}
</script>

<template>
  <LimitStatusBadge v-if="panelError" data-testid="limit-panel-fallback" />

  <section v-else class="limit-top-panel" data-testid="limit-top-panel" aria-label="Provider limits top panel">
    <template v-if="loading">
      <article v-for="index in 4" :key="index" class="panel-card skeleton-card" data-testid="limit-panel-loading">
        <Skeleton :lines="4" />
      </article>
    </template>

    <template v-else>
      <article
        v-for="card in providerCards"
        :key="card.provider"
        class="panel-card provider-card"
        :class="`status-${card.status}`"
        :data-provider="card.provider"
        :data-testid="`limit-provider-${card.provider}`"
      >
        <header class="card-head">
          <div class="provider-title">
            <b>{{ card.label }}</b>
            <span>{{ card.checkedLabel }}</span>
          </div>
          <span class="status-pill" :class="card.status">{{ card.statusLabel }}</span>
        </header>

        <div v-if="card.latest.length && !card.unsupported" class="usage-row">
          <strong class="usage-value" :class="severityForPercent(card.maxPercent)">{{ card.percentLabel }}</strong>
          <span>{{ card.resetLabel }}</span>
        </div>

        <div v-if="card.latest.length && !card.unsupported" class="sparkline" :data-testid="`sparkline-${card.provider}`">
          <svg viewBox="0 0 96 30" role="img" :aria-label="`${card.label} usage trend`">
            <polyline v-if="card.sparklinePoints" :points="card.sparklinePoints" />
          </svg>
          <span v-if="!card.sparklinePoints" class="spark-empty">No trend</span>
        </div>

        <div v-if="card.latest.length && !card.unsupported" class="window-bars">
          <div v-for="row in card.windows" :key="row.snapshot.id" class="window-row" :class="{ stale: row.stale }">
            <span class="window-label" :title="row.snapshot.label">{{ row.snapshot.label }}</span>
            <span
              class="window-track"
              role="progressbar"
              :aria-label="`${card.label} ${row.snapshot.label} usage`"
              :aria-valuenow="row.percent ?? undefined"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <span v-if="row.percent !== null" class="window-fill" :class="row.severity" :style="{ width: row.width }" />
              <span v-else class="window-unknown" />
            </span>
            <span class="window-percent">{{ row.percentLabel }}</span>
          </div>
        </div>

        <div v-else class="provider-empty">
          <b>{{ card.unsupported ? 'Unsupported' : 'No limit snapshot' }}</b>
          <span>{{ card.message ?? 'No provider snapshot recorded.' }}</span>
          <button type="button" class="panel-button ghost" :disabled="limits.refreshing" data-testid="empty-refresh" @click="refresh">
            {{ limits.refreshing ? 'Refreshing' : 'Refresh' }}
          </button>
        </div>

        <p v-if="card.message && card.latest.length && !card.unsupported" class="inline-error">{{ card.message }}</p>
        <span class="history-count">{{ latestHistoryCount(card.provider) }} snapshots</span>
      </article>

      <article class="panel-card gate-card" :class="gateState" data-testid="limit-gate-card">
        <header class="card-head">
          <div class="provider-title">
            <b>Gate</b>
            <span>{{ freshnessLabel }}</span>
          </div>
          <span class="status-pill" :class="gateState">{{ gateState === 'blocked' ? 'Block' : 'Allow' }}</span>
        </header>

        <strong class="gate-label">{{ gateLabel(gate) }}</strong>
        <p class="gate-reason">{{ gate?.reason ?? 'No gate decision loaded.' }}</p>
        <p v-if="gate?.selectedWindow" class="gate-meta">
          {{ labels[gate.selectedWindow.provider] }} / {{ gate.selectedWindow.label }}
        </p>
        <p class="gate-meta">Resume {{ countdown(gate?.resumeAfter, 'not scheduled') }}</p>

        <div v-if="firstBlockedJob" class="blocked-summary" data-testid="limit-blocked-summary">
          <b>{{ firstBlockedJob.blockedReason ?? 'Blocked by active limit rule' }}</b>
          <span>Resume {{ countdown(firstBlockedJob.resumeAfter, 'waiting') }}</span>
        </div>

        <div class="lane-list" data-testid="limit-lanes">
          <span
            v-for="lane in lanes"
            :key="lane.provider"
            class="lane-chip"
            :class="{ full: lane.full }"
            :data-provider="lane.provider"
          >
            {{ lane.label }} {{ lane.active }}/{{ lane.limit }}
          </span>
          <span v-if="!lanes.length" class="lane-empty">{{ queue.loadError ?? 'Queue lanes waiting' }}</span>
        </div>

        <div v-if="limits.loadError || limits.refreshError" class="panel-error" data-testid="limit-panel-error">
          {{ limits.loadError ?? limits.refreshError }}
        </div>

        <div class="panel-actions">
          <button type="button" class="panel-button" :disabled="limits.refreshing" data-testid="limit-refresh" @click="refresh">
            {{ limits.refreshing ? 'Refreshing' : 'Refresh' }}
          </button>
          <button type="button" class="panel-button ghost" data-testid="limit-open-details" @click="openDetails">Open details</button>
        </div>
      </article>
    </template>
  </section>
</template>

<style scoped>
.limit-top-panel {
  min-width: 0;
  display: flex;
  align-items: stretch;
  gap: 8px;
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 2px;
}
.panel-card {
  flex: 0 0 226px;
  min-width: 226px;
  min-height: 90px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
}
.gate-card {
  flex-basis: 278px;
  min-width: 278px;
}
.skeleton-card {
  justify-content: center;
}
.card-head,
.usage-row,
.window-row,
.panel-actions,
.lane-list {
  display: flex;
  align-items: center;
}
.card-head {
  justify-content: space-between;
  gap: 8px;
}
.provider-title {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.provider-title b,
.gate-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.provider-title span,
.usage-row span,
.gate-meta,
.history-count,
.spark-empty,
.provider-empty span,
.lane-empty {
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1.25;
}
.status-pill {
  flex: none;
  display: inline-flex;
  align-items: center;
  min-height: 18px;
  padding: 1px 6px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: 9px;
  font-weight: 800;
  text-transform: uppercase;
  white-space: nowrap;
}
.status-pill.healthy,
.status-pill.allowed {
  color: var(--green);
  border-color: var(--green);
}
.status-pill.amber,
.status-pill.stale,
.status-pill.unsupported {
  color: var(--amber);
  border-color: var(--amber);
}
.status-pill.red,
.status-pill.blocked,
.status-pill.error {
  color: var(--red);
  border-color: var(--red);
}
.status-blocked,
.gate-card.blocked {
  border-color: var(--red);
}
.status-stale,
.status-unsupported {
  border-color: var(--amber);
}
.status-error {
  border-color: var(--red);
}
.usage-row {
  justify-content: space-between;
  gap: 8px;
}
.usage-value {
  font-family: var(--font-mono);
  font-size: 18px;
  line-height: 1;
}
.usage-value.ok,
.usage-value.healthy {
  color: var(--green);
}
.usage-value.amber {
  color: var(--amber);
}
.usage-value.red {
  color: var(--red);
}
.usage-value.unknown {
  color: var(--text-faint);
}
.sparkline {
  position: relative;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-term);
  overflow: hidden;
}
.sparkline svg {
  width: 100%;
  height: 100%;
  display: block;
}
.sparkline polyline {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}
.spark-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
}
.window-bars {
  display: grid;
  gap: 4px;
}
.window-row {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(42px, 0.8fr) minmax(62px, 1fr) minmax(48px, auto);
  gap: 5px;
}
.window-label,
.window-percent {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
  font-size: 10px;
}
.window-percent {
  text-align: right;
  font-family: var(--font-mono);
}
.window-row.stale .window-label {
  color: var(--amber);
}
.window-track {
  position: relative;
  height: 7px;
  align-self: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
  overflow: hidden;
}
.window-fill,
.window-unknown {
  display: block;
  height: 100%;
}
.window-fill.ok {
  background: var(--green);
}
.window-fill.amber {
  background: var(--amber);
}
.window-fill.red {
  background: var(--red);
}
.window-fill.unknown,
.window-unknown {
  background: var(--slate);
  opacity: 0.45;
}
.provider-empty {
  min-height: 58px;
  display: grid;
  align-content: center;
  gap: 5px;
}
.provider-empty b {
  font-size: 12px;
}
.inline-error,
.panel-error {
  color: var(--red);
  font-size: 10px;
  line-height: 1.25;
  overflow-wrap: anywhere;
}
.history-count {
  margin-top: auto;
}
.gate-label {
  display: block;
  font-size: 14px;
}
.gate-reason {
  margin: 0;
  max-height: 30px;
  overflow: hidden;
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.35;
}
.gate-meta {
  margin: 0;
}
.blocked-summary {
  display: grid;
  gap: 2px;
  padding: 5px 6px;
  border: 1px solid var(--amber);
  border-radius: var(--radius-sm);
  color: var(--amber);
  background: color-mix(in srgb, var(--amber) 10%, transparent);
}
.blocked-summary b,
.blocked-summary span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
}
.lane-list {
  flex-wrap: wrap;
  gap: 4px;
}
.lane-chip {
  display: inline-flex;
  align-items: center;
  min-height: 18px;
  padding: 1px 5px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: 10px;
  font-weight: 700;
}
.lane-chip.full {
  color: var(--amber);
  border-color: var(--amber);
}
.panel-actions {
  gap: 5px;
  margin-top: auto;
}
.panel-button {
  min-height: 24px;
  padding: 2px 8px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-elev-2);
  color: var(--text);
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}
.panel-button.ghost {
  background: transparent;
  color: var(--text-dim);
}
.panel-button:not(:disabled):hover {
  border-color: var(--accent);
}
.panel-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

@media (max-width: 980px) {
  .panel-card {
    flex-basis: 214px;
    min-width: 214px;
  }
  .gate-card {
    flex-basis: 258px;
    min-width: 258px;
  }
}
</style>
