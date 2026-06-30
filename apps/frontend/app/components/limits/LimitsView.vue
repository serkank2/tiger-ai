<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import BaseCheckbox from '~/components/ui/BaseCheckbox.vue';
import EmptyState from '~/components/ui/EmptyState.vue';
import Skeleton from '~/components/ui/Skeleton.vue';
import { useConnectionStore } from '~/stores/connection';
import { useLimitsStore } from '~/stores/limits';
import type { LimitRule, LimitRuleInput, LimitSnapshot, TigerAgentType } from '~/types';
import {
  gateLabel,
  isSnapshotStale,
  normalizedPercent,
  percentText,
  severityForPercent,
  sortSnapshotsNewestFirst,
} from '~/lib/limits';

const emit = defineEmits<{ back: [] }>();

const conn = useConnectionStore();
const limits = useLimitsStore();
const { t } = useT();
const rawOpen = ref<Record<string, boolean>>({});

const providers: TigerAgentType[] = ['claude', 'codex', 'antigravity'];

const providerCards = computed(() =>
  providers.map((provider) => {
    const backend = limits.providers?.[provider];
    return {
      provider,
      latest: backend?.latest ?? limits.latest.filter((snapshot) => snapshot.provider === provider),
      latestCheckedAt: backend?.latestCheckedAt ?? null,
      ok: backend?.ok ?? false,
      error: backend?.error,
    };
  }),
);

const history = computed(() => sortSnapshotsNewestFirst(limits.snapshots).slice(0, 16));
const decision = computed(() => limits.decision);

// --- Rule editor ---
const WINDOW_OPTIONS = ['any', '5h', 'weekly', 'session', 'probe'];

interface RuleDraft {
  provider: TigerAgentType;
  windowKey: string;
  thresholdPercent: number;
  enabled: boolean;
}

function draftFromRule(rule: LimitRule): RuleDraft {
  return {
    provider: rule.provider,
    windowKey: rule.windowKey,
    thresholdPercent: rule.thresholdPercent,
    enabled: rule.enabled,
  };
}

const drafts = reactive<Record<string, RuleDraft>>({});
const newRule = reactive<RuleDraft>({ provider: 'claude', windowKey: 'any', thresholdPercent: 90, enabled: true });

function draftFor(rule: LimitRule): RuleDraft {
  if (!drafts[rule.id]) drafts[rule.id] = draftFromRule(rule);
  return drafts[rule.id]!;
}

function isDirty(rule: LimitRule): boolean {
  const d = drafts[rule.id];
  if (!d) return false;
  return (
    d.provider !== rule.provider ||
    d.windowKey !== rule.windowKey ||
    Number(d.thresholdPercent) !== rule.thresholdPercent ||
    d.enabled !== rule.enabled
  );
}

async function saveRule(rule: LimitRule) {
  const d = draftFor(rule);
  const body: LimitRuleInput = {
    provider: d.provider,
    windowKey: d.windowKey,
    thresholdPercent: Number(d.thresholdPercent),
    enabled: d.enabled,
  };
  try {
    await limits.updateRule(rule.id, body);
    delete drafts[rule.id];
  } catch {
    /* error surfaced via limits.ruleError */
  }
}

const dialog = useDialog();

async function removeRule(rule: LimitRule) {
  const ok = await dialog.confirm({
    title: t('limits.view.deleteRuleTitle'),
    message: t('limits.view.deleteRuleMessage', { provider: rule.provider, window: rule.windowKey }),
    confirmText: t('common.delete'),
    danger: true,
  });
  if (!ok) return;
  try {
    await limits.deleteRule(rule.id);
    delete drafts[rule.id];
  } catch {
    /* error surfaced via limits.ruleError */
  }
}

async function addRule() {
  try {
    await limits.createRule({
      provider: newRule.provider,
      windowKey: newRule.windowKey,
      thresholdPercent: Number(newRule.thresholdPercent),
      enabled: newRule.enabled,
    });
    Object.assign(newRule, { provider: 'claude', windowKey: 'any', thresholdPercent: 90, enabled: true });
  } catch {
    /* error surfaced via limits.ruleError */
  }
}

function refresh() {
  void limits.refresh().catch(() => {});
}

function fmtDate(iso?: string | null): string {
  if (!iso) return t('common.status.unknown');
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return t('common.status.unknown');
  return new Date(time).toLocaleString();
}

function freshness(snapshot: LimitSnapshot): 'fresh' | 'stale' {
  return isSnapshotStale(snapshot, limits.staleAfterMs) ? 'stale' : 'fresh';
}

function statusText(snapshot: LimitSnapshot): string {
  if (!snapshot.ok) return 'error';
  return freshness(snapshot);
}

function toggleRaw(snapshot: LimitSnapshot) {
  rawOpen.value = { ...rawOpen.value, [snapshot.id]: !rawOpen.value[snapshot.id] };
}

function widthFor(snapshot: LimitSnapshot): string {
  return `${normalizedPercent(snapshot.percentUsed) ?? 0}%`;
}

function rawPanel(snapshot: LimitSnapshot): string {
  return snapshot.rawPanel?.trim() || t('limits.view.noRawPanel');
}

onMounted(() => {
  if (!limits.loaded && !limits.loading) void limits.load();
});
</script>

<template>
  <section class="limits-view">
    <header class="limits-head">
      <BaseButton variant="secondary" @click="emit('back')">{{ t('common.back') }}</BaseButton>
      <div class="head-copy">
        <h1>{{ t('nav.limits') }}</h1>
        <p>
          {{ t('limits.view.updated', { date: fmtDate(limits.updatedAt) }) }}
          <span class="dotsep">/</span>
          {{ conn.status }}
        </p>
      </div>
      <BaseButton variant="secondary" :loading="limits.refreshing" @click="refresh">
        {{ limits.refreshing ? t('limits.panel.refreshing') : t('common.refresh') }}
      </BaseButton>
    </header>

    <div class="state-row">
      <p v-if="conn.status === 'disconnected'" class="notice danger">{{ t('limits.view.disconnected') }}</p>
      <p v-if="limits.loadError" class="notice danger">{{ limits.loadError }}</p>
      <p v-if="limits.refreshError" class="notice danger">{{ limits.refreshError }}</p>
      <p v-if="limits.stale" class="notice warn">{{ t('limits.view.staleNotice') }}</p>
    </div>

    <div v-if="limits.loading && !limits.loaded" class="loading-grid">
      <Skeleton :lines="4" />
      <Skeleton :lines="4" />
    </div>

    <EmptyState
      v-else-if="limits.loaded && !limits.hasData"
      :title="t('limits.view.noSnapshotsTitle')"
      :description="t('limits.view.noSnapshotsDesc')"
    >
      <template #actions>
        <BaseButton variant="secondary" :loading="limits.refreshing" @click="refresh">{{
          t('common.refresh')
        }}</BaseButton>
      </template>
    </EmptyState>

    <template v-else>
      <section class="gate-panel" :class="{ blocked: decision?.action === 'block' }">
        <div>
          <p class="eyebrow">{{ t('limits.view.currentGate') }}</p>
          <h2>{{ gateLabel(decision) }}</h2>
          <p class="gate-reason">{{ decision?.reason ?? t('limits.view.noDecisionLoaded') }}</p>
        </div>
        <dl class="gate-meta">
          <div>
            <dt>{{ t('limits.view.checked') }}</dt>
            <dd>{{ fmtDate(decision?.checkedAt) }}</dd>
          </div>
          <div>
            <dt>{{ t('limits.view.resumeAfter') }}</dt>
            <dd>{{ fmtDate(decision?.resumeAfter) }}</dd>
          </div>
          <div v-if="decision?.selectedWindow">
            <dt>{{ t('limits.view.selectedWindow') }}</dt>
            <dd>{{ decision.selectedWindow.provider }} / {{ decision.selectedWindow.label }}</dd>
          </div>
        </dl>
      </section>

      <section class="provider-grid">
        <article v-for="provider in providerCards" :key="provider.provider" class="provider-card">
          <header class="provider-head">
            <div>
              <p class="eyebrow">{{ provider.provider }}</p>
              <h2>{{ t('limits.view.windowCount', { n: provider.latest.length }) }}</h2>
            </div>
            <span class="status-pill" :class="{ bad: !provider.ok }">
              {{
                provider.ok
                  ? t('common.ok').toLowerCase()
                  : provider.error
                    ? t('common.status.error').toLowerCase()
                    : t('common.status.empty').toLowerCase()
              }}
            </span>
          </header>
          <p class="provider-time">{{ t('limits.view.checkedAt', { date: fmtDate(provider.latestCheckedAt) }) }}</p>
          <p v-if="provider.error" class="inline-error">{{ provider.error }}</p>

          <div v-if="provider.latest.length" class="window-list">
            <article v-for="snapshot in provider.latest" :key="snapshot.id" class="window-card">
              <div class="window-top">
                <div>
                  <h3>{{ snapshot.label }}</h3>
                  <p>{{ snapshot.windowKey }}</p>
                </div>
                <span class="percent" :class="severityForPercent(snapshot.percentUsed)">
                  {{ percentText(snapshot.percentUsed) }}
                </span>
              </div>
              <div
                class="track"
                role="progressbar"
                :aria-valuenow="normalizedPercent(snapshot.percentUsed) ?? 0"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-label="`${snapshot.label} usage`"
              >
                <div
                  class="fill"
                  :class="severityForPercent(snapshot.percentUsed)"
                  :style="{ width: widthFor(snapshot) }"
                />
              </div>
              <dl class="snapshot-meta">
                <div>
                  <dt>{{ t('limits.view.checked') }}</dt>
                  <dd>{{ fmtDate(snapshot.checkedAt) }}</dd>
                </div>
                <div>
                  <dt>{{ t('limits.view.reset') }}</dt>
                  <dd>{{ fmtDate(snapshot.resetAt) }}</dd>
                </div>
                <div>
                  <dt>{{ t('limits.view.resetText') }}</dt>
                  <dd>{{ snapshot.resetText || t('common.status.unknown') }}</dd>
                </div>
                <div>
                  <dt>{{ t('limits.view.metric') }}</dt>
                  <dd>
                    <template v-if="snapshot.metricRaw">
                      {{ snapshot.metricRaw.percent }}% {{ snapshot.metricRaw.metric }}
                    </template>
                    <template v-else>{{ t('common.status.unknown') }}</template>
                  </dd>
                </div>
                <div>
                  <dt>{{ t('limits.view.parse') }}</dt>
                  <dd>{{ snapshot.parseConfidence }}</dd>
                </div>
                <div>
                  <dt>{{ t('limits.view.status') }}</dt>
                  <dd>
                    <span
                      class="status-pill compact"
                      :class="{ bad: statusText(snapshot) === 'error', warn: statusText(snapshot) === 'stale' }"
                    >
                      {{
                        statusText(snapshot) === 'error'
                          ? t('common.status.error')
                          : t('limits.freshness.' + statusText(snapshot))
                      }}
                    </span>
                  </dd>
                </div>
              </dl>
              <p v-if="snapshot.error" class="inline-error">{{ snapshot.error }}</p>
              <BaseButton
                size="sm"
                variant="ghost"
                class="raw-toggle"
                :aria-expanded="!!rawOpen[snapshot.id]"
                @click="toggleRaw(snapshot)"
              >
                {{ rawOpen[snapshot.id] ? t('limits.view.hideRaw') : t('limits.view.showRaw') }}
              </BaseButton>
              <pre v-if="rawOpen[snapshot.id]" class="raw-panel">{{ rawPanel(snapshot) }}</pre>
            </article>
          </div>
          <p v-else class="provider-empty">{{ t('limits.view.noLatest') }}</p>
        </article>
      </section>

      <section class="rules-panel">
        <header class="section-head">
          <div>
            <p class="eyebrow">{{ t('limits.view.rules') }}</p>
            <h2>{{ t('limits.view.gateRules') }}</h2>
          </div>
          <span class="status-pill">{{ t('limits.view.editable') }}</span>
        </header>

        <p v-if="limits.ruleError" class="notice danger rule-notice">{{ limits.ruleError }}</p>

        <div v-if="limits.rules.length" class="rules-list">
          <article v-for="rule in limits.rules" :key="rule.id" class="rule-row editable">
            <label>
              <span>{{ t('limits.view.provider') }}</span>
              <select v-model="draftFor(rule).provider" :disabled="limits.savingRule">
                <option v-for="p in providers" :key="p" :value="p">{{ p }}</option>
              </select>
            </label>
            <label>
              <span>{{ t('limits.view.window') }}</span>
              <select v-model="draftFor(rule).windowKey" :disabled="limits.savingRule">
                <option v-for="w in WINDOW_OPTIONS" :key="w" :value="w">{{ w }}</option>
              </select>
            </label>
            <label>
              <span>{{ t('limits.view.threshold') }}</span>
              <input
                v-model.number="draftFor(rule).thresholdPercent"
                type="number"
                min="0"
                max="100"
                :disabled="limits.savingRule"
              />
            </label>
            <BaseCheckbox
              v-model="draftFor(rule).enabled"
              :label="t('limits.view.enabled')"
              :disabled="limits.savingRule"
              class="checkline"
            />
            <div class="rule-actions">
              <BaseButton size="sm" :loading="limits.savingRule" :disabled="!isDirty(rule)" @click="saveRule(rule)">{{
                t('common.save')
              }}</BaseButton>
              <BaseButton size="sm" variant="danger" :disabled="limits.savingRule" @click="removeRule(rule)">{{
                t('common.delete')
              }}</BaseButton>
            </div>
          </article>
        </div>
        <p v-else class="provider-empty">{{ t('limits.view.noRules') }}</p>

        <article class="rule-row editable new-rule">
          <label>
            <span>{{ t('limits.view.provider') }}</span>
            <select v-model="newRule.provider" :disabled="limits.savingRule">
              <option v-for="p in providers" :key="p" :value="p">{{ p }}</option>
            </select>
          </label>
          <label>
            <span>{{ t('limits.view.window') }}</span>
            <select v-model="newRule.windowKey" :disabled="limits.savingRule">
              <option v-for="w in WINDOW_OPTIONS" :key="w" :value="w">{{ w }}</option>
            </select>
          </label>
          <label>
            <span>{{ t('limits.view.threshold') }}</span>
            <input
              v-model.number="newRule.thresholdPercent"
              type="number"
              min="0"
              max="100"
              :disabled="limits.savingRule"
            />
          </label>
          <BaseCheckbox
            v-model="newRule.enabled"
            :label="t('limits.view.enabled')"
            :disabled="limits.savingRule"
            class="checkline"
          />

          <div class="rule-actions">
            <BaseButton size="sm" variant="primary" :loading="limits.savingRule" @click="addRule">{{
              t('limits.view.addRule')
            }}</BaseButton>
          </div>
        </article>
      </section>

      <section class="history-panel">
        <header class="section-head">
          <div>
            <p class="eyebrow">{{ t('limits.view.history') }}</p>
            <h2>{{ t('limits.view.recentSnapshots') }}</h2>
          </div>
          <span class="status-pill">{{ history.length }}</span>
        </header>
        <div v-if="history.length" class="history-table">
          <div class="history-head">
            <span>{{ t('limits.view.provider') }}</span>
            <span>{{ t('limits.view.window') }}</span>
            <span>{{ t('limits.view.used') }}</span>
            <span>{{ t('limits.view.checked') }}</span>
            <span>{{ t('limits.view.reset') }}</span>
            <span>{{ t('limits.view.status') }}</span>
          </div>
          <div v-for="snapshot in history" :key="snapshot.id" class="history-row">
            <span>{{ snapshot.provider }}</span>
            <span>{{ snapshot.label }}</span>
            <span>{{ percentText(snapshot.percentUsed) }}</span>
            <span>{{ fmtDate(snapshot.checkedAt) }}</span>
            <span>{{ fmtDate(snapshot.resetAt) }}</span>
            <span>{{ snapshot.ok ? t('limits.freshness.' + freshness(snapshot)) : t('common.status.error') }}</span>
          </div>
        </div>
        <p v-else class="provider-empty">{{ t('limits.view.noSnapshotHistory') }}</p>
      </section>
    </template>
  </section>
</template>

<style scoped>
.limits-view {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--bg);
  padding: 18px;
}
.limits-head,
.section-head,
.provider-head,
.window-top,
.state-row {
  display: flex;
  align-items: center;
}
.limits-head {
  gap: 14px;
  margin-bottom: 16px;
}
.head-copy {
  min-width: 0;
  flex: 1;
}
h1,
h2,
h3,
p {
  margin: 0;
}
h1 {
  font-size: 24px;
}
h2 {
  font-size: 16px;
}
h3 {
  font-size: 14px;
}
.head-copy p,
.provider-time,
.provider-empty,
.gate-reason,
.window-top p {
  margin-top: 4px;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.45;
}
.dotsep {
  color: var(--text-faint);
  margin: 0 5px;
}
.state-row {
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}
.notice {
  padding: 7px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
  font-size: 12px;
}
.notice.danger {
  color: var(--red);
  border-color: var(--red);
}
.notice.warn {
  color: var(--amber);
  border-color: var(--amber);
}
.loading-grid,
.provider-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.loading-grid {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
}
.gate-panel,
.provider-card,
.rules-panel,
.history-panel {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
}
.gate-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 0.7fr);
  gap: 18px;
  padding: 16px;
  margin-bottom: 14px;
}
.gate-panel.blocked {
  border-color: var(--red);
}
.eyebrow {
  margin-bottom: 4px;
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}
.gate-meta,
.snapshot-meta {
  display: grid;
  gap: 8px;
  margin: 0;
}
.gate-meta {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.snapshot-meta {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-top: 10px;
}
dt {
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}
dd {
  margin: 2px 0 0;
  color: var(--text);
  font-size: 12px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.provider-card {
  padding: 14px;
  min-width: 0;
}
.provider-head,
.section-head,
.window-top {
  justify-content: space-between;
  gap: 12px;
}
.status-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 22px;
  padding: 2px 8px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--green);
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
  white-space: nowrap;
}
.status-pill.bad {
  color: var(--red);
  border-color: var(--red);
}
.status-pill.warn {
  color: var(--amber);
  border-color: var(--amber);
}
.status-pill.compact {
  min-height: 18px;
  padding: 0 6px;
  font-size: 10px;
}
.window-list {
  display: grid;
  gap: 10px;
  margin-top: 12px;
}
.window-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  padding: 12px;
}
.percent {
  font-family: var(--font-mono);
  font-size: 18px;
  font-weight: 800;
  white-space: nowrap;
}
.percent.ok {
  color: var(--green);
}
.percent.amber {
  color: var(--amber);
}
.percent.red {
  color: var(--red);
}
.percent.unknown {
  color: var(--text-faint);
}
.track {
  height: 8px;
  margin-top: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-term);
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--slate);
}
.fill.ok {
  background: var(--green);
}
.fill.amber {
  background: var(--amber);
}
.fill.red {
  background: var(--red);
}
.inline-error {
  margin-top: 10px;
  color: var(--red);
  font-size: 12px;
  line-height: 1.45;
}
.raw-toggle {
  margin-top: 10px;
}
.raw-panel {
  max-height: 240px;
  overflow: auto;
  margin: 10px 0 0;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-term);
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
.rules-panel,
.history-panel {
  margin-top: 14px;
  padding: 14px;
}
.rules-list {
  display: grid;
  gap: 10px;
  margin-top: 12px;
}
.rule-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
}
.rule-row label {
  display: grid;
  gap: 5px;
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
}
.rule-row input,
.rule-row select {
  min-width: 0;
  color: var(--text);
  background: var(--bg-elev);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 4px 6px;
  font: inherit;
}
.rule-row.editable {
  grid-template-columns: repeat(4, minmax(0, 1fr)) auto;
  align-items: end;
}
.rule-row.new-rule {
  margin-top: 12px;
  border-style: dashed;
}
.rule-actions {
  display: flex;
  gap: 6px;
  align-self: end;
}
.rule-notice {
  margin-top: 12px;
}
.checkline {
  align-self: end;
}
.history-table {
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.history-head,
.history-row {
  display: grid;
  grid-template-columns: 0.8fr 1.1fr 0.55fr 1.4fr 1.4fr 0.7fr;
  gap: 8px;
  align-items: center;
  min-width: 760px;
}
.history-head {
  padding: 8px 10px;
  background: var(--bg);
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
}
.history-row {
  padding: 9px 10px;
  border-top: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 12px;
}

@media (max-width: 920px) {
  .limits-view {
    padding: 12px;
  }
  .limits-head {
    flex-wrap: wrap;
  }
  .provider-grid,
  .loading-grid,
  .gate-panel {
    grid-template-columns: 1fr;
  }
  .rule-row {
    grid-template-columns: 1fr 1fr;
  }
  .history-table {
    overflow-x: auto;
  }
}

@media (max-width: 560px) {
  .rule-row,
  .snapshot-meta,
  .gate-meta {
    grid-template-columns: 1fr;
  }
  .refresh,
  .back {
    flex: 1;
  }
}
</style>
