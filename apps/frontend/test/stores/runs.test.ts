import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useRunsStore } from '~/stores/runs';
import type { RunEventDto, RunSnapshot } from '~/types';

const api = vi.hoisted(() => ({
  getCurrentRun: vi.fn(),
  createRun: vi.fn(),
  startRun: vi.fn(),
  stopRun: vi.fn(),
  steerRun: vi.fn(),
  listRunEvents: vi.fn(),
  getRunChanges: vi.fn(),
  listRuns: vi.fn(),
  getRunById: vi.fn(),
}));

vi.mock('~/composables/useApi', () => ({ useApi: () => api }));

function snapshot(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: 'run-1',
    workspace: 'C:/w',
    goal: 'Do the thing',
    status: 'running',
    createdAt: '2026-07-02T10:00:00.000Z',
    profile: 'mission',
    seq: 3,
    usage: { turns: 1, costUsd: 0.02 },
    graph: { items: [] },
    verifications: [],
    steering: [],
    ...over,
  };
}

function event(seq: number, over: Partial<RunEventDto> = {}): RunEventDto {
  return { seq, at: 'x', type: 'note', runId: 'run-1', text: `event ${seq}`, ...over };
}

describe('runs store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('load() applies the snapshot and replays missed events after lastSeq', async () => {
    const runs = useRunsStore();
    api.getCurrentRun.mockResolvedValue({ run: snapshot() });
    api.listRunEvents.mockResolvedValue({ events: [event(1), event(2)] });

    await runs.load();

    expect(runs.run?.runId).toBe('run-1');
    expect(runs.events.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(api.listRunEvents).toHaveBeenCalledWith(0);
  });

  it('appendEvent() dedupes by seq and caps the feed', () => {
    const runs = useRunsStore();
    runs.appendEvent(event(1));
    runs.appendEvent(event(1)); // duplicate → dropped
    runs.appendEvent(event(2));
    expect(runs.events).toHaveLength(2);
    expect(runs.lastSeq).toBe(2);

    for (let seq = 3; seq <= 600; seq += 1) runs.appendEvent(event(seq));
    expect(runs.events.length).toBeLessThanOrEqual(500);
    expect(runs.events.at(-1)?.seq).toBe(600);
  });

  it('create() resets the feed and applies the new snapshot', async () => {
    const runs = useRunsStore();
    runs.appendEvent(event(9));
    api.createRun.mockResolvedValue({ run: snapshot({ runId: 'run-2', status: 'created' }) });

    await runs.create({ workspace: 'C:/w', goal: 'New goal' });

    expect(runs.run?.runId).toBe('run-2');
    expect(runs.events).toHaveLength(0);
    expect(runs.lastSeq).toBe(0);
  });

  it('loadChanges()/loadHistory()/openHistoryRun() populate their state', async () => {
    const runs = useRunsStore();
    api.getRunChanges.mockResolvedValue({
      changes: {
        isGitRepo: true,
        head: 'abc',
        branch: 'main',
        files: [{ path: 'a.ts', status: 'modified' }],
        diff: '+x',
        diffTruncated: false,
        summary: { files: 1, insertions: 1, deletions: 0 },
        generatedAt: 'now',
      },
    });
    api.listRuns.mockResolvedValue({
      runs: [
        {
          runId: 'run-0',
          workspace: 'C:/w',
          goalPreview: 'old goal',
          status: 'completed',
          createdAt: 'x',
          turns: 4,
          itemsDone: 3,
          itemsTotal: 3,
        },
      ],
    });
    api.getRunById.mockResolvedValue({ run: snapshot({ runId: 'run-0', status: 'completed' }) });

    await runs.loadChanges();
    await runs.loadHistory();
    await runs.openHistoryRun('run-0');

    expect(runs.changes?.summary.files).toBe(1);
    expect(runs.history).toHaveLength(1);
    expect(runs.historyRun?.runId).toBe('run-0');

    await runs.openHistoryRun(null);
    expect(runs.historyRun).toBeNull();
  });

  it('steer() surfaces failures via loadError and rethrows', async () => {
    const runs = useRunsStore();
    api.steerRun.mockRejectedValue(new Error('run is stopped'));
    await expect(runs.steer('focus')).rejects.toThrow('run is stopped');
    expect(runs.loadError).toContain('run is stopped');
  });
});
