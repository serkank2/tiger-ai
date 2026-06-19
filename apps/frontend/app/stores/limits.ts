import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { LimitRuleInput, LimitStatus } from '~/types';
import { errText } from '~/lib/apiError';
import { hasStaleLatest, latestSnapshotErrors, maxLatestPercent, severityForPercent } from '~/lib/limits';

export const useLimitsStore = defineStore('limits', () => {
  const status = ref<LimitStatus | null>(null);
  const loaded = ref(false);
  const loading = ref(false);
  const refreshing = ref(false);
  const loadError = ref<string | null>(null);
  const refreshError = ref<string | null>(null);
  const lastRefreshStartedAt = ref<string | null>(null);

  const latest = computed(() => status.value?.latest ?? []);
  const snapshots = computed(() => status.value?.snapshots ?? []);
  const rules = computed(() => status.value?.rules ?? []);
  const decision = computed(() => status.value?.decision ?? null);
  const providers = computed(() => status.value?.providers ?? null);
  const staleAfterMs = computed(() => status.value?.staleAfterMs ?? 15 * 60 * 1000);
  const updatedAt = computed(() => status.value?.updatedAt ?? null);
  const maxPercentUsed = computed(() => maxLatestPercent(status.value));
  const severity = computed(() => severityForPercent(maxPercentUsed.value));
  const hasData = computed(() => latest.value.length > 0);
  const stale = computed(() => hasStaleLatest(status.value));
  const latestErrors = computed(() => latestSnapshotErrors(status.value));
  const hasErrors = computed(() => latestErrors.value.length > 0 || !!loadError.value || !!refreshError.value);

  function applyState(next: LimitStatus) {
    status.value = next;
    loaded.value = true;
    loadError.value = null;
    refreshError.value = null;
  }

  async function load() {
    if (loading.value) return;
    loading.value = true;
    try {
      applyState(await useApi().getLimits());
    } catch (error) {
      loadError.value = errText(error);
      // Mark the page resolved even on failure so it renders the error notice + empty state
      // (with the header Refresh as a working retry) instead of stranding on a blank body —
      // `loaded` gates every render branch, so leaving it false hides the whole view.
      loaded.value = true;
    } finally {
      loading.value = false;
    }
  }

  async function refresh() {
    if (refreshing.value) return;
    refreshing.value = true;
    refreshError.value = null;
    lastRefreshStartedAt.value = new Date().toISOString();
    try {
      applyState(await useApi().refreshLimits());
    } catch (error) {
      refreshError.value = errText(error);
      throw error;
    } finally {
      refreshing.value = false;
    }
  }

  const savingRule = ref(false);
  const ruleError = ref<string | null>(null);

  async function createRule(input: LimitRuleInput) {
    savingRule.value = true;
    ruleError.value = null;
    try {
      applyState(await useApi().createLimitRule(input));
    } catch (error) {
      ruleError.value = errText(error);
      throw error;
    } finally {
      savingRule.value = false;
    }
  }

  async function updateRule(id: string, input: LimitRuleInput) {
    savingRule.value = true;
    ruleError.value = null;
    try {
      applyState(await useApi().updateLimitRule(id, input));
    } catch (error) {
      ruleError.value = errText(error);
      throw error;
    } finally {
      savingRule.value = false;
    }
  }

  async function deleteRule(id: string) {
    savingRule.value = true;
    ruleError.value = null;
    try {
      applyState(await useApi().deleteLimitRule(id));
    } catch (error) {
      ruleError.value = errText(error);
      throw error;
    } finally {
      savingRule.value = false;
    }
  }

  return {
    status,
    loaded,
    loading,
    refreshing,
    loadError,
    refreshError,
    lastRefreshStartedAt,
    latest,
    snapshots,
    rules,
    decision,
    providers,
    staleAfterMs,
    updatedAt,
    maxPercentUsed,
    severity,
    hasData,
    stale,
    latestErrors,
    hasErrors,
    savingRule,
    ruleError,
    applyState,
    load,
    refresh,
    createRule,
    updateRule,
    deleteRule,
  };
});
