import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config as appConfig } from '../config.js';
import { toRunSnapshot, type RunEvent, type RunSnapshot, type RunState, type RunStatus } from './types.js';

// ---------------------------------------------------------------------------
// Run history. Every run persists its full state under
// `<workspace>/.tiger/runs/<runId>/`; this module maintains a small global
// INDEX (data dir) so past runs are listable without knowing their workspaces,
// and read-only accessors that rehydrate a snapshot / event log from disk.
// The engine is the only writer of the index.
// ---------------------------------------------------------------------------

export interface RunIndexEntry {
  runId: string;
  workspace: string;
  /** First 200 chars of the goal, for list rendering. */
  goalPreview: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  costUsd?: number;
  turns: number;
  itemsDone: number;
  itemsTotal: number;
}

const INDEX_CAP = 200;

export function runIndexFile(): string {
  return path.join(appConfig.dataDir, 'runs-index.json');
}

export async function readRunIndex(): Promise<RunIndexEntry[]> {
  try {
    const raw = JSON.parse(await fs.readFile(runIndexFile(), 'utf8')) as { runs?: RunIndexEntry[] };
    return (raw.runs ?? []).filter((entry) => entry && typeof entry.runId === 'string');
  } catch {
    return [];
  }
}

/** Upsert one run's entry (newest first) and persist. Best-effort: never throws. */
export async function upsertRunIndex(state: RunState): Promise<void> {
  try {
    const entries = await readRunIndex();
    const next: RunIndexEntry = {
      runId: state.runId,
      workspace: state.workspace,
      goalPreview: state.goal.slice(0, 200),
      status: state.status,
      createdAt: state.createdAt,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      costUsd: state.usage.costUsd,
      turns: state.usage.turns,
      itemsDone: state.graph.items.filter((item) => item.status === 'done').length,
      itemsTotal: state.graph.items.length,
    };
    const rest = entries.filter((entry) => entry.runId !== state.runId);
    const merged = [next, ...rest].slice(0, INDEX_CAP);
    const file = runIndexFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const json = JSON.stringify({ runs: merged }, null, 2);
    await fs.writeFile(tmp, json, 'utf8');
    try {
      await fs.rename(tmp, file);
    } catch {
      // Windows AV can transiently EPERM the swap; the index is derived data.
      await fs.writeFile(file, json, 'utf8').catch(() => {});
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  } catch {
    /* index is derived data — never take the engine down for it */
  }
}

/** Rehydrate a past run's snapshot from its on-disk state. Null when missing/corrupt. */
export async function readRunSnapshot(workspace: string, runId: string): Promise<RunSnapshot | null> {
  try {
    const file = path.join(workspace, '.tiger', 'runs', runId, 'state.json');
    const state = JSON.parse(await fs.readFile(file, 'utf8')) as RunState;
    if (state.runId !== runId) return null;
    return toRunSnapshot(state);
  } catch {
    return null;
  }
}

/** Read a past run's event log (after `afterSeq`). Empty when missing. */
export async function readRunEvents(workspace: string, runId: string, afterSeq = 0): Promise<RunEvent[]> {
  const file = path.join(workspace, '.tiger', 'runs', runId, 'events.jsonl');
  const raw = await fs.readFile(file, 'utf8').catch(() => '');
  const events: RunEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as RunEvent;
      if (event.runId === runId && event.seq > afterSeq) events.push(event);
    } catch {
      /* skip corrupt line */
    }
  }
  return events;
}
