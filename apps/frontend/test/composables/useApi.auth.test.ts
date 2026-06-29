import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApi } from '~/composables/useApi';

const AUTH_TOKEN_KEY = 'kaplan.authToken';

describe('useApi auth token + git-write routes', () => {
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
    await api.getTeamState();
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/team/state', undefined);
  });

  it('attaches Authorization: Bearer <token> to every request when a token is set', async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, 'sekret');
    const api = useApi();

    await api.getTeamState();
    expect(fetchMock).toHaveBeenLastCalledWith('http://api.test/api/team/state', {
      headers: { Authorization: 'Bearer sekret' },
    });

    await api.stopTeamRun('run/1');
    expect(fetchMock).toHaveBeenLastCalledWith('http://api.test/api/team/runs/run%2F1/stop', {
      method: 'POST',
      headers: { Authorization: 'Bearer sekret' },
    });

    await api.downloadTeamExport('run/1', 'markdown');
    expect(fetchMock).toHaveBeenLastCalledWith('http://api.test/api/team/runs/run%2F1/export?format=markdown', {
      responseType: 'blob',
      headers: { Authorization: 'Bearer sekret' },
    });
  });

  it('wires the git stage/commit/pr routes', async () => {
    const api = useApi();

    await api.stageTeamChanges('run/1');
    expect(fetchMock).toHaveBeenLastCalledWith('http://api.test/api/team/runs/run%2F1/git/stage', { method: 'POST' });

    await api.commitTeamChanges('run/1', 'do the thing');
    expect(fetchMock).toHaveBeenLastCalledWith('http://api.test/api/team/runs/run%2F1/git/commit', {
      method: 'POST',
      body: { message: 'do the thing' },
    });

    await api.createTeamPr('run/1', { title: 'My PR', body: 'desc', base: 'main' });
    expect(fetchMock).toHaveBeenLastCalledWith('http://api.test/api/team/runs/run%2F1/git/pr', {
      method: 'POST',
      body: { title: 'My PR', body: 'desc', base: 'main' },
    });
  });

  it('rethrows backend errors so callers can read the error code', async () => {
    fetchMock.mockRejectedValueOnce({ status: 422, data: { error: { code: 'validation_failed', message: 'message required' } } });
    const api = useApi();
    await expect(api.commitTeamChanges('run/1', '')).rejects.toMatchObject({
      data: { error: { code: 'validation_failed' } },
    });
  });
});
