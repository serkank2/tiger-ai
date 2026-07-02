import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApi } from '~/composables/useApi';

const AUTH_TOKEN_KEY = 'kaplan.authToken';

describe('useApi auth token + run routes', () => {
  const fetchMock = vi.fn();
  let store: Record<string, string> = {};

  beforeEach(() => {
    fetchMock.mockResolvedValue({});
    store = {};
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: 'http://api.test' } }));
    vi.stubGlobal('$fetch', fetchMock);
    // Deterministic in-memory localStorage (the host's experimental global lacks methods).
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('omits the Authorization header when no token is set (second arg stays untouched)', async () => {
    const api = useApi();
    await api.getCurrentRun();
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/runs/current', undefined);
  });

  it('attaches Authorization: Bearer <token> to every request when a token is set', async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'sekret');
    const api = useApi();

    await api.getCurrentRun();
    expect(fetchMock).toHaveBeenLastCalledWith('http://api.test/api/runs/current', {
      headers: { Authorization: 'Bearer sekret' },
    });

    await api.stopRun();
    expect(fetchMock).toHaveBeenLastCalledWith('http://api.test/api/runs/current/stop', {
      method: 'POST',
      body: {},
      headers: { Authorization: 'Bearer sekret' },
    });
  });

  it('wires the run control routes', async () => {
    const api = useApi();

    await api.createRun({ workspace: '/w', goal: 'Do it' });
    expect(fetchMock).toHaveBeenLastCalledWith('http://api.test/api/runs', {
      method: 'POST',
      body: { workspace: '/w', goal: 'Do it' },
    });

    await api.steerRun('focus');
    expect(fetchMock).toHaveBeenLastCalledWith('http://api.test/api/runs/current/steer', {
      method: 'POST',
      body: { body: 'focus' },
    });

    await api.listRunEvents(7);
    expect(fetchMock).toHaveBeenLastCalledWith('http://api.test/api/runs/current/events?afterSeq=7', undefined);
  });

  it('rethrows backend errors so callers can read the error code', async () => {
    fetchMock.mockRejectedValueOnce({
      status: 422,
      data: { error: { code: 'validation_failed', message: 'message required' } },
    });
    const api = useApi();
    await expect(api.steerRun('')).rejects.toMatchObject({
      data: { error: { code: 'validation_failed' } },
    });
  });
});
