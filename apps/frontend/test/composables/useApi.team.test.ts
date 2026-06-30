import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApi } from '~/composables/useApi';

describe('useApi Team methods', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockResolvedValue({});
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: 'http://api.test' } }));
    vi.stubGlobal('$fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('wires Team templates, state, controls, steering, transcript, and artifacts', async () => {
    const api = useApi();

    await api.listTeamTemplates();
    await api.getTeamState();
    await api.startTeamRun({ templateId: 'template-1', goal: 'Build it' });
    await api.pauseTeamRun('run/1');
    await api.resumeTeamRun('run/1');
    await api.stopTeamRun('run/1');
    await api.steerTeamRun('run/1', { body: 'Focus on testing', target: 'tester' });
    await api.listTeamMessages('run/1', { cursor: 'abc', limit: 25 });
    await api.listTeamArtifacts('run/1');
    await api.readTeamArtifact('run/1', 'reports/plan.md');
    await api.downloadTeamExport('run/1', 'json');

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://api.test/api/team/templates', undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://api.test/api/team/state', undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'http://api.test/api/team/runs', {
      method: 'POST',
      body: { templateId: 'template-1', goal: 'Build it' },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'http://api.test/api/team/runs/run%2F1/pause', { method: 'POST' });
    expect(fetchMock).toHaveBeenNthCalledWith(5, 'http://api.test/api/team/runs/run%2F1/resume', { method: 'POST' });
    expect(fetchMock).toHaveBeenNthCalledWith(6, 'http://api.test/api/team/runs/run%2F1/stop', { method: 'POST' });
    expect(fetchMock).toHaveBeenNthCalledWith(7, 'http://api.test/api/team/runs/run%2F1/steer', {
      method: 'POST',
      body: { body: 'Focus on testing', target: 'tester' },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      8,
      'http://api.test/api/team/runs/run%2F1/messages?cursor=abc&limit=25',
      undefined,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(9, 'http://api.test/api/team/runs/run%2F1/artifacts', undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(
      10,
      'http://api.test/api/team/runs/run%2F1/artifacts/file?path=reports%2Fplan.md',
      undefined,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(11, 'http://api.test/api/team/runs/run%2F1/export?format=json', {
      responseType: 'blob',
    });
  });
});
