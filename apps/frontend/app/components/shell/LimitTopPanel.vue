<script setup lang="ts">
import { computed, onBeforeUnmount, onErrorCaptured, onMounted, ref, watch } from 'vue';
import LimitStatusBadge from '~/components/shell/LimitStatusBadge.vue';
import { useSocket } from '~/composables/useSocket';
import { useT } from '~/composables/useT';
import { useConnectionStore } from '~/stores/connection';
import { useLimitsStore } from '~/stores/limits';
import { useQueueStore } from '~/stores/queue';
import {
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
const { t } = useT();

const nowMs = ref(Date.now());
const panelError = ref<string | null>(null);
// Expanded view reveals the per-window detail + sparkline beneath the compact band.
const expandedProvider = ref<TigerAgentType | null>(null);

let clock: ReturnType<typeof setInterval> | null = null;
let unsubscribeLimitState: (() => void) | null = null;
let unsubscribeQueueState: (() => void) | null = null;

onErrorCaptured((error) => {
  panelError.value = error instanceof Error ? error.message : t('shell.limitTopPanel.fallback');
  return false;
});

const loading = computed(() => !limits.loaded && !limits.loadError);

const freshnessLabel = computed(() => {
  if (conn.status === 'disconnected') return t('limits.freshness.disconnected');
  if (limits.stale) return t('limits.freshness.stale');
  if (!limits.hasData) return t('limits.freshness.noSnapshots');
  return t('limits.freshness.fresh');
});

const gate = computed(() => limits.decision);
const gateState = computed(() => (gate.value?.action === 'block' ? 'blocked' : 'allowed'));
const gateBlocked = computed(() => gateState.value === 'blocked');
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

const providerChips = computed(() =>
  PROVIDERS.map((provider) => {
    const backend = limits.providers?.[provider];
    const latest = sortedByWindow(
      backend?.latest?.length ? backend.latest : limits.latest.filter((item) => item.provider === provider),
    );
    const current = latest[0] ?? null;
    const maxPercent = normalizedPercent(current?.percentUsed);
    const unsupported = unsupportedMessage(provider, latest, backend?.error);
    const stale = latest.some((snapshot) => isSnapshotStale(snapshot, limits.staleAfterMs, nowMs.value));
    const errored = latest.some((snapshot) => !snapshot.ok || !!snapshot.error) || !!backend?.error;
    const status = providerStatus({ latest, maxPercent, stale, errored, unsupported, provider });
    const series = sparklineSeries(provider, current?.windowKey ?? latest[0]?.windowKey ?? null);
    const resetText = resetLabel(current);

    return {
      provider,
      label: labels[provider],
      latest,
      hasData: latest.length > 0 && !unsupported,
      unsupported,
      maxPercent,
      percentLabel: unsupported ? 'n/a' : percentText(maxPercent),
      fillWidth: `${maxPercent ?? 0}%`,
      severity: unsupported ? 'unknown' : severityForPercent(maxPercent),
      status,
      statusLabel: statusLabel(status),
      tier: statusTier(status),
      resetLabel: resetText,
      checkedLabel: checkedLabel(backend?.latestCheckedAt ?? current?.checkedAt ?? null),
      message: unsupported ?? backend?.error ?? latest.find((item) => item.error)?.error ?? null,
      sparklinePoints: sparklinePoints(series),
      historyCount: sortSnapshotsNewestFirst(limits.snapshots.filter((snapshot) => snapshot.provider === provider))
        .length,
      windows: latest.map((snapshot) => ({
        snapshot,
        percent: normalizedPercent(snapshot.percentUsed),
        percentLabel: percentText(snapshot.percentUsed),
        width: `${normalizedPercent(snapshot.percentUsed) ?? 0}%`,
        stale: isSnapshotStale(snapshot, limits.staleAfterMs, nowMs.value),
        severity: severityForPercent(snapshot.percentUsed),
      })),
      title: buildTitle(
        labels[provider],
        latest,
        statusLabel(status),
        resetText,
        message(unsupported, backend?.error, latest),
      ),
    };
  }),
);

const expandedChip = computed(
  () => providerChips.value.find((chip) => chip.provider === expandedProvider.value) ?? null,
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

function toggleExpand(provider: TigerAgentType): void {
  expandedProvider.value = expandedProvider.value === provider ? null : provider;
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
  if (status === 'healthy') return t('limits.status.healthy');
  if (status === 'amber') return t('limits.status.warn');
  if (status === 'red') return t('limits.status.high');
  if (status === 'blocked') return t('limits.status.blocked');
  if (status === 'stale') return t('limits.status.stale');
  if (status === 'error') return t('limits.status.error');
  if (status === 'unsupported') return t('limits.status.unsupported');
  if (status === 'empty') return t('limits.status.empty');
  return t('limits.status.unknown');
}

/** Visual severity tier for dot colour / chip tint. */
function statusTier(status: string): 'red' | 'amber' | 'ok' | 'muted' {
  if (status === 'red' || status === 'blocked' || status === 'error') return 'red';
  if (status === 'amber' || status === 'stale') return 'amber';
  if (status === 'healthy') return 'ok';
  return 'muted';
}

function sortedByWindow(snapshots: LimitSnapshot[]): LimitSnapshot[] {
  return [...snapshots].sort((a, b) => {
    const aPercent = normalizedPercent(a.percentUsed) ?? -1;
    const bPercent = normalizedPercent(b.percentUsed) ?? -1;
    return bPercent - aPercent || a.label.localeCompare(b.label);
  });
}

function message(unsupported: string | null, backendError: string | undefined, latest: LimitSnapshot[]): string | null {
  return unsupported ?? backendError ?? latest.find((item) => item.error)?.error ?? null;
}

function unsupportedMessage(provider: TigerAgentType, latest: LimitSnapshot[], backendError?: string): string | null {
  if (provider !== 'antigravity') return null;
  const snapshotError = latest.find((snapshot) => snapshot.error)?.error;
  const msg = backendError ?? snapshotError ?? '';
  const lower = msg.toLowerCase();
  if (
    lower.includes('unsupported') ||
    lower.includes('no usage') ||
    lower.includes('no limit') ||
    lower.includes('agy')
  ) {
    return msg || t('limits.panel.antigravityUnsupported');
  }
  if (!latest.length) return t('limits.panel.antigravityUnsupported');
  if (latest.every((snapshot) => !snapshot.ok && normalizedPercent(snapshot.percentUsed) === null)) {
    return msg || t('limits.panel.antigravityUnsupported');
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
  return items
    .map((snapshot) => normalizedPercent(snapshot.percentUsed))
    .filter((value): value is number => value !== null);
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
  if (!snapshot) return t('limits.panel.resetUnknown');
  if (snapshot.resetAt)
    return t('limits.panel.resetLabel', { value: countdown(snapshot.resetAt, t('limits.panel.resetWaiting')) });
  if (snapshot.resetText) return t('limits.panel.resetLabel', { value: snapshot.resetText });
  return t('limits.panel.resetUnknown');
}

function checkedLabel(iso: string | null): string {
  if (!iso) return t('limits.panel.checkedNever');
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return t('limits.panel.checkedNever');
  const diff = Math.max(0, nowMs.value - time);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return t('limits.panel.checkedNow');
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

function buildTitle(label: string, latest: LimitSnapshot[], status: string, reset: string, msg: string | null): string {
  const lines = [`${label} — ${status}`];
  for (const snapshot of latest) lines.push(`${snapshot.label}: ${percentText(snapshot.percentUsed)}`);
  lines.push(reset);
  if (msg) lines.push(msg);
  return lines.join('\n');
}
</script>

<template>
  <LimitStatusBadge v-if="panelError" data-testid="limit-panel-fallback" />

  <section
    v-else
    class="limit-top-panel"
    data-testid="limit-top-panel"
    :aria-label="t('shell.limitTopPanel.providerLimits')"
  >
    <div class="chip-row">
      <template v-if="loading">
        <span
          v-for="index in 4"
          :key="index"
          class="provider-chip is-loading"
          data-testid="limit-panel-loading"
          aria-hidden="true"
        >
          <span class="dot" />
          <span class="chip-skel-name" />
          <span class="chip-track"><span class="chip-fill skel" /></span>
        </span>
      </template>

      <template v-else>
        <button
          v-for="chip in providerChips"
          :key="chip.provider"
          type="button"
          class="provider-chip"
          :class="[
            `tier-${chip.tier}`,
            {
              'is-warn': chip.tier === 'amber',
              'is-danger': chip.tier === 'red',
              'is-open': expandedProvider === chip.provider,
            },
          ]"
          :data-provider="chip.provider"
          :data-testid="`limit-provider-${chip.provider}`"
          :title="chip.title"
          role="status"
          :aria-expanded="expandedProvider === chip.provider"
          :aria-label="`${chip.label} ${chip.statusLabel}. Usage ${chip.unsupported ? 'unsupported' : chip.percentLabel}. ${chip.resetLabel}.`"
          @click="toggleExpand(chip.provider)"
        >
          <span class="dot" :class="`tier-${chip.tier}`" aria-hidden="true" />
          <span class="chip-name">{{ chip.label }}</span>
          <span class="chip-status" :class="`tier-${chip.tier}`">{{ chip.statusLabel }}</span>

          <template v-if="chip.hasData">
            <span class="chip-percent" :class="chip.severity">{{ chip.percentLabel }}</span>
            <span
              class="chip-track"
              role="progressbar"
              :aria-label="`${chip.label} usage`"
              :aria-valuenow="chip.maxPercent ?? undefined"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <span class="chip-fill" :class="chip.severity" :style="{ width: chip.fillWidth }" />
            </span>
            <span class="chip-reset">{{ chip.resetLabel }}</span>
          </template>

          <span v-else class="chip-na" :title="chip.message ?? undefined">
            {{ chip.unsupported ? t('limits.status.unsupported') : t('limits.panel.noLimitSnapshot') }}
            <em v-if="chip.message" class="chip-na-msg">{{ chip.message }}</em>
          </span>

          <!-- Detail trend retained for the expanded view / a11y; collapsed out of the compact band. -->
          <span class="chip-sparkline" :data-testid="`sparkline-${chip.provider}`" aria-hidden="true">
            <svg
              viewBox="0 0 96 30"
              role="img"
              :aria-label="t('shell.limitTopPanel.providerUsageTrend', { provider: chip.label })"
            >
              <polyline v-if="chip.sparklinePoints" :points="chip.sparklinePoints" />
            </svg>
          </span>
        </button>

        <button
          type="button"
          class="provider-chip gate-chip"
          :class="{ 'is-danger': gateBlocked }"
          :data-state="gateState"
          data-testid="limit-gate-card"
          :title="`${t('shell.limitTopPanel.gateTitle', { state: gateBlocked ? t('limits.gate.block') : t('limits.gate.allow') })}\n${gate?.reason ?? t('limits.gate.noDecision')}\n${freshnessLabel}`"
          role="status"
          :aria-label="`${t('shell.limitTopPanel.gateTitle', { state: gateBlocked ? t('limits.gate.block') : t('limits.gate.allow') })}. ${gate?.reason ?? ''}`"
          @click="openDetails"
        >
          <span class="dot" :class="gateBlocked ? 'tier-red' : 'tier-ok'" aria-hidden="true" />
          <span class="chip-name">{{ t('limits.gate.label') }}</span>
          <span class="chip-gate-state" :class="{ blocked: gateBlocked }">{{
            gateBlocked ? t('limits.gate.block') : t('limits.gate.allow')
          }}</span>
          <span class="chip-reset gate-reason">{{ gate?.reason ?? freshnessLabel }}</span>

          <span v-if="firstBlockedJob" class="visually-hidden" data-testid="limit-blocked-summary">
            {{ firstBlockedJob.blockedReason ?? 'Blocked by active limit rule' }} — Resume
            {{ countdown(firstBlockedJob.resumeAfter, 'waiting') }}
          </span>
        </button>

        <span
          v-if="lanes.length"
          class="lane-strip"
          data-testid="limit-lanes"
          :aria-label="t('shell.limitTopPanel.queueLanes')"
        >
          <span
            v-for="lane in lanes"
            :key="lane.provider"
            class="lane-chip"
            :class="{ full: lane.full }"
            :data-provider="lane.provider"
            :title="`${lane.label} ${lane.active}/${lane.limit} active`"
            >{{ lane.label }} {{ lane.active }}/{{ lane.limit }}</span
          >
        </span>

        <span class="panel-controls">
          <button
            type="button"
            class="icon-button"
            :disabled="limits.refreshing"
            data-testid="limit-refresh"
            :title="limits.refreshing ? t('limits.panel.refreshing') : t('shell.limitTopPanel.refresh')"
            :aria-label="t('shell.limitTopPanel.refresh')"
            @click="refresh"
          >
            {{ limits.refreshing ? '…' : '↻' }}
          </button>
          <button
            type="button"
            class="icon-button"
            data-testid="limit-open-details"
            :title="t('shell.limitTopPanel.openDetails')"
            :aria-label="t('shell.limitTopPanel.openDetails')"
            @click="openDetails"
          >
            ⋯
          </button>
        </span>

        <span
          v-if="limits.loadError || limits.refreshError"
          class="panel-error"
          data-testid="limit-panel-error"
          role="alert"
          :title="limits.loadError ?? limits.refreshError ?? ''"
          >! {{ limits.loadError ?? limits.refreshError }}</span
        >
      </template>
    </div>

    <!-- Expanded detail drawer: per-window bars + trend for the selected provider. -->
    <div v-if="expandedChip && expandedChip.hasData" class="expand-drawer" data-testid="limit-expand-drawer">
      <strong class="expand-title"
        >{{ expandedChip.label }} · {{ expandedChip.checkedLabel }} · {{ expandedChip.historyCount }} snapshots</strong
      >
      <div class="window-bars">
        <div
          v-for="row in expandedChip.windows"
          :key="row.snapshot.id"
          class="window-row"
          :class="{ stale: row.stale }"
        >
          <span class="window-label" :title="row.snapshot.label">{{ row.snapshot.label }}</span>
          <span
            class="window-track"
            role="progressbar"
            :aria-label="`${expandedChip.label} ${row.snapshot.label} usage`"
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
      <span class="expand-sparkline">
        <svg viewBox="0 0 96 30" role="img" :aria-label="`${expandedChip.label} usage trend`">
          <polyline v-if="expandedChip.sparklinePoints" :points="expandedChip.sparklinePoints" />
        </svg>
      </span>
    </div>
  </section>
</template>

<style scoped>
.limit-top-panel {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.chip-row {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  overflow-y: hidden;
}
.provider-chip {
  flex: 0 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.provider-chip:hover,
.provider-chip.is-open {
  border-color: var(--accent);
}
.provider-chip.is-warn {
  border-color: var(--amber);
  background: color-mix(in srgb, var(--amber) 8%, var(--bg));
}
.provider-chip.is-danger {
  border-color: var(--red);
  background: color-mix(in srgb, var(--red) 12%, var(--bg));
}
.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--slate);
}
.dot.tier-ok {
  background: var(--green);
}
.dot.tier-amber {
  background: var(--amber);
}
.dot.tier-red {
  background: var(--red);
  box-shadow: 0 0 6px var(--red);
}
.is-danger .dot.tier-red {
  animation: limit-pulse 1.4s infinite;
}
.chip-name {
  font-weight: 700;
  font-size: 12px;
}
.chip-status {
  font-size: 9px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: var(--text-faint);
}
.chip-status.tier-ok {
  color: var(--green);
}
.chip-status.tier-amber {
  color: var(--amber);
}
.chip-status.tier-red {
  color: var(--red);
}
.chip-percent {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
}
.chip-percent.ok,
.chip-percent.healthy {
  color: var(--green);
}
.chip-percent.amber {
  color: var(--amber);
}
.chip-percent.red {
  color: var(--red);
}
.chip-percent.unknown {
  color: var(--text-faint);
}
.chip-track {
  flex: none;
  position: relative;
  width: 56px;
  height: 5px;
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  overflow: hidden;
}
.chip-fill {
  display: block;
  height: 100%;
  background: var(--slate);
  transition: width 0.25s ease;
}
.chip-fill.ok,
.chip-fill.healthy {
  background: var(--green);
}
.chip-fill.amber {
  background: var(--amber);
}
.chip-fill.red {
  background: var(--red);
}
.chip-fill.unknown {
  background: var(--slate);
  opacity: 0.45;
}
.chip-reset,
.chip-na {
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1;
}
.is-danger .chip-reset {
  color: var(--red);
}
.chip-na-msg {
  font-style: normal;
  /* Message kept in DOM for detail/tests but not shown inline in the compact band. */
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.chip-gate-state {
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
  color: var(--green);
}
.chip-gate-state.blocked {
  color: var(--red);
}
.gate-reason {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Sparkline retained in the DOM (a11y + expanded detail), collapsed out of the band. */
.chip-sparkline {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.lane-strip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.lane-chip {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 5px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}
.lane-chip.full {
  color: var(--amber);
  border-color: var(--amber);
}
.panel-controls {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-elev-2);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
}
.icon-button:not(:disabled):hover {
  border-color: var(--accent);
}
.icon-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.panel-error {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 220px;
  padding: 0 8px;
  height: 22px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--red) 14%, var(--bg));
  border: 1px solid var(--red);
  color: var(--red);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Loading skeleton chips */
.provider-chip.is-loading {
  cursor: default;
  opacity: 0.7;
}
.chip-skel-name {
  width: 46px;
  height: 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
}
.chip-fill.skel {
  width: 40%;
  background: var(--slate);
  opacity: 0.4;
}

/* Expanded detail drawer */
.expand-drawer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
}
.expand-title {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
}
.window-bars {
  display: grid;
  gap: 3px;
  flex: 1;
  min-width: 0;
}
.window-row {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(60px, 0.6fr) minmax(80px, 1fr) minmax(40px, auto);
  align-items: center;
  gap: 6px;
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
  height: 6px;
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
.expand-sparkline {
  flex: none;
  width: 96px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-term);
  overflow: hidden;
}
.expand-sparkline svg {
  width: 100%;
  height: 100%;
  display: block;
}
.expand-sparkline polyline {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}

@keyframes limit-pulse {
  50% {
    opacity: 0.35;
  }
}
@media (prefers-reduced-motion: reduce) {
  .is-danger .dot.tier-red {
    animation: none;
  }
  .chip-fill {
    transition: none;
  }
}
</style>
