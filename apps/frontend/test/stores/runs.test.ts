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
  interactiveInput: vi.fn(),
  interactiveComplete: vi.fn(),
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
    importance: 'normal',
    council: { plan: 1, review: 1, providers: ['claude'] },
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

  it('agent events accumulate into per-agent terminal panes (result ends the turn, usage adds no line)', () => {
    const runs = useRunsStore();
    const agentEvent = (seq: number, type: string, over: Partial<RunEventDto> = {}) =>
      event(seq, {
        type: 'agent',
        itemId: 'T1',
        agentId: 'builder',
        provider: 'claude',
        model: 'opus',
        agent: { type: type as never, at: `at-${seq}`, text: `${type} ${seq}` },
        ...over,
      });

    runs.appendEvent(agentEvent(1, 'turn-started'));
    runs.appendEvent(agentEvent(2, 'text'));
    runs.appendEvent(agentEvent(3, 'usage'));
    runs.appendEvent(agentEvent(4, 'stderr'));
    runs.appendEvent(
      event(5, {
        type: 'agent',
        itemId: 'P1',
        agentId: 'plan-candidate-1',
        provider: 'codex',
        agent: { type: 'text', at: 'at-5', text: 'candidate speaks' },
      }),
    );

    expect(runs.terminalList.map((pane) => pane.id)).toEqual(['builder', 'plan-candidate-1']);
    const builder = runs.terminals['builder']!;
    expect(builder.provider).toBe('claude');
    expect(builder.model).toBe('opus');
    expect(builder.live).toBe(true);
    // usage events update liveness but add no scrollback line.
    expect(builder.lines.map((line) => line.type)).toEqual(['turn-started', 'text', 'stderr']);

    runs.appendEvent(agentEvent(6, 'result'));
    expect(runs.terminals['builder']!.live).toBe(false);
  });

  it('interactiveInput/interactiveComplete call the API by agentId', async () => {
    const runs = useRunsStore();
    api.interactiveInput.mockResolvedValue({ ok: true });
    api.interactiveComplete.mockResolvedValue({ ok: true });
    await runs.interactiveInput('T1', '/compact\r');
    await runs.interactiveComplete('T1');
    expect(api.interactiveInput).toHaveBeenCalledWith('T1', '/compact\r');
    expect(api.interactiveComplete).toHaveBeenCalledWith('T1');
  });

  it('a settled run.state snapshot marks every terminal idle', () => {
    const runs = useRunsStore();
    runs.appendEvent(
      event(1, {
        type: 'agent',
        agentId: 'builder',
        provider: 'claude',
        agent: { type: 'text', at: 'a', text: 'hi' },
      }),
    );
    expect(runs.terminals['builder']!.live).toBe(true);
    runs.applySnapshot(snapshot({ status: 'completed' }));
    expect(runs.terminals['builder']!.live).toBe(false);
  });
});
