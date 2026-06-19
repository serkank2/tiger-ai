import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { useApi } from '~/composables/useApi';
import { errText } from '~/lib/apiError';
import type { CueEngineStatus, CueSubscriptionStatus } from '~/types';

/**
 * Cue engine store. Mirrors the existing limits/queue store idioms: a single `status` ref, a
 * `loaded` gate so the page can render an error/empty state instead of stranding blank, and
 * per-action busy keys so individual trigger buttons can show their own spinner.
 *
 * The Cue engine is OFF by default on the backend; when it is disabled the status call returns a
 * 409 (`cue engine is not enabled`), which we surface as `disabled = true` rather than an error.
 */
export const useCueStore = defineStore('cue', () => {
  const api = useApi();

  const status = ref<CueEngineStatus | null>(null);
  const loaded = ref(false);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  const disabled = ref(false);
  const busyKeys = ref<Record<string, boolean>>({});

  const subscriptions = computed<CueSubscriptionStatus[]>(() => status.value?.subscriptions ?? []);
  const running = computed(() => status.value?.running ?? false);
  const workspace = computed(() => status.value?.workspace ?? null);
  const configPath = computed(() => status.value?.configPath ?? null);
  const manualSubscriptions = computed(() => subscriptions.value.filter((s) => s.event === 'cli.trigger'));

  function setBusy(key: string, busy: boolean): void {
    const next = { ...busyKeys.value };
    if (busy) next[key] = true;
    else delete next[key];
    busyKeys.value = next;
  }
  function isBusy(key: string): boolean {
    return !!busyKeys.value[key];
  }

  function applyStatus(next: CueEngineStatus): void {
    status.value = next;
    disabled.value = false;
    loadError.value = null;
    loaded.value = true;
  }

  /** Detect the backend's "cue engine is not enabled" 409 so the page shows a friendly notice. */
  function isDisabledError(e: unknown): boolean {
    const err = e as { status?: number; statusCode?: number; data?: { error?: { message?: string } } };
    const code = err?.status ?? err?.statusCode;
    const message = err?.data?.error?.message ?? '';
    return code === 409 || /not enabled/i.test(message);
  }

  async function load(): Promise<void> {
    if (loading.value) return;
    loading.value = true;
    try {
      applyStatus(await api.getCueStatus());
    } catch (e) {
      if (isDisabledError(e)) {
        disabled.value = true;
        loadError.value = null;
      } else {
        loadError.value = errText(e);
      }
      loaded.value = true;
    } finally {
      loading.value = false;
    }
  }

  async function reload(): Promise<void> {
    setBusy('reload', true);
    try {
      applyStatus(await api.reloadCue());
    } catch (e) {
      if (isDisabledError(e)) disabled.value = true;
      else loadError.value = errText(e);
      throw e;
    } finally {
      setBusy('reload', false);
    }
  }

  async function trigger(id: string): Promise<void> {
    const key = `trigger:${id}`;
    setBusy(key, true);
    loadError.value = null;
    try {
      await api.triggerCue(id);
      // Refresh so the fired subscription's lastFiredAt / fireCount update.
      await load();
    } catch (e) {
      loadError.value = errText(e);
      throw e;
    } finally {
      setBusy(key, false);
    }
  }

  return {
    status,
    loaded,
    loading,
    loadError,
    disabled,
    busyKeys,
    subscriptions,
    manualSubscriptions,
    running,
    workspace,
    configPath,
    isBusy,
    applyStatus,
    load,
    reload,
    trigger,
  };
});
