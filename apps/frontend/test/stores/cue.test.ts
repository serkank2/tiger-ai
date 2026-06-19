import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useCueStore } from '~/stores/cue';
import type { CueEngineStatus, CueSubscriptionStatus } from '~/types';

const api = vi.hoisted(() => ({
  getCueStatus: vi.fn(),
  reloadCue: vi.fn(),
  triggerCue: vi.fn(),
}));

vi.mock('~/composables/useApi', () => ({ useApi: () => api }));

function sub(partial: Partial<CueSubscriptionStatus> = {}): CueSubscriptionStatus {
  return {
    id: 'deploy',
    name: 'Deploy on push',
    event: 'cli.trigger',
    target: 'queue',
    enabled: true,
    lastFiredAt: null,
    fireCount: 0,
    lastError: null,
    ...partial,
  };
}

function status(partial: Partial<CueEngineStatus> = {}): CueEngineStatus {
  return {
    enabled: true,
    running: true,
    workspace: 'C:\\proj',
    configPath: 'C:\\proj\\.kaplan\\cue.json',
    subscriptions: [sub()],
    ...partial,
  };
}

describe('cue store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    api.getCueStatus.mockReset();
    api.reloadCue.mockReset();
    api.triggerCue.mockReset();
  });

  it('loads status and exposes subscriptions + running flag', async () => {
    api.getCueStatus.mockResolvedValue(status());
    const store = useCueStore();
    await store.load();
    expect(store.loaded).toBe(true);
    expect(store.disabled).toBe(false);
    expect(store.running).toBe(true);
    expect(store.subscriptions).toHaveLength(1);
    expect(store.manualSubscriptions).toHaveLength(1);
    expect(store.workspace).toBe('C:\\proj');
  });

  it('marks disabled (not errored) on a 409 from a disabled engine', async () => {
    api.getCueStatus.mockRejectedValue({ status: 409, data: { error: { message: 'cue engine is not enabled' } } });
    const store = useCueStore();
    await store.load();
    expect(store.disabled).toBe(true);
    expect(store.loadError).toBeNull();
    expect(store.loaded).toBe(true);
  });

  it('surfaces a non-disabled load failure as an error', async () => {
    api.getCueStatus.mockRejectedValue(new Error('boom'));
    const store = useCueStore();
    await store.load();
    expect(store.disabled).toBe(false);
    expect(store.loadError).toBeTruthy();
  });

  it('trigger fires the subscription then reloads status', async () => {
    api.triggerCue.mockResolvedValue(sub({ fireCount: 1, lastFiredAt: '2026-06-19T00:00:00.000Z' }));
    api.getCueStatus.mockResolvedValue(status({ subscriptions: [sub({ fireCount: 1 })] }));
    const store = useCueStore();
    await store.trigger('deploy');
    expect(api.triggerCue).toHaveBeenCalledWith('deploy');
    expect(api.getCueStatus).toHaveBeenCalled();
    expect(store.subscriptions[0]!.fireCount).toBe(1);
    expect(store.isBusy('trigger:deploy')).toBe(false);
  });

  it('reload applies fresh status', async () => {
    api.reloadCue.mockResolvedValue(status({ running: false }));
    const store = useCueStore();
    await store.reload();
    expect(store.running).toBe(false);
    expect(store.loaded).toBe(true);
  });
});
