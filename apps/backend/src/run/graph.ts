// ---------------------------------------------------------------------------
// WorkGraph — the v2 unit of orchestration (docs/REDESIGN.md §4.2).
//
// A run is a graph of WORK ITEMS with dependencies, not a rotation of role
// turns. Control flow lives HERE, in code: the scheduler is a pure function
// over the graph, so it is deterministic, unit-testable, and can never be
// talked out of its invariants by an agent. LLM turns are spent only on
// plan / build / review items; verification is engine-run, not an item.
// ---------------------------------------------------------------------------

export type WorkItemKind = 'plan' | 'build' | 'review';

export type WorkItemStatus =
  /** Waiting on dependencies (or scheduling capacity). */
  | 'pending'
  /** An agent turn is executing this item right now. */
  | 'running'
  /** Build finished; engine-run checks are executing. */
  | 'verifying'
  | 'done'
  /** Exhausted its attempts (or depends on a blocked item); the rest of the graph continues. */
  | 'blocked'
  | 'cancelled';

export interface WorkItemUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface WorkItem {
  /** Stable id: "T1", "T2", … (planner-assigned) or engine-generated ("FIX-T2-1"). */
  id: string;
  kind: WorkItemKind;
  title: string;
  /** Self-contained brief body — the planner writes it detailed enough to execute alone. */
  description: string;
  acceptanceCriteria?: string[];
  /** Item ids that must be `done` before this item may run. */
  dependsOn: string[];
  status: WorkItemStatus;
  /** Agent slot that executes this item (session continuity key), e.g. "builder". */
  agentKey: string;
  attempts: number;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  /** The structured result summary of the last completed turn for this item. */
  resultSummary?: string;
  /** Why the item is blocked/cancelled, when it is. */
  error?: string;
  /** For review items: the scope being reviewed ("run" or a build item id). */
  reviewOf?: string;
  /** For engine-generated fix items: what evidence spawned them. */
  fixOf?: string;
  /** Per-item accumulated usage across its turns. */
  usage?: WorkItemUsage;
  /** Worktree binding when this build item runs isolated. */
  worktree?: { path: string; branch: string } | null;
}

export interface RunGraph {
  items: WorkItem[];
}

export interface SelectOptions {
  /** How many build items may run concurrently (1 unless worktree isolation is on). */
  maxParallelBuilds: number;
}

/** True when every dependency is done (a cancelled/blocked dep blocks the dependent). */
export function depsSatisfied(graph: RunGraph, item: WorkItem): boolean {
  return item.dependsOn.every((depId) => graph.items.find((entry) => entry.id === depId)?.status === 'done');
}

/** True when a dependency can never complete (blocked/cancelled), so the item can't either. */
export function depsDoomed(graph: RunGraph, item: WorkItem): boolean {
  return item.dependsOn.some((depId) => {
    const dep = graph.items.find((entry) => entry.id === depId);
    return dep === undefined || dep.status === 'blocked' || dep.status === 'cancelled';
  });
}

const ACTIVE_STATUSES: readonly WorkItemStatus[] = ['running', 'verifying'];

export function activeItems(graph: RunGraph): WorkItem[] {
  return graph.items.filter((item) => ACTIVE_STATUSES.includes(item.status));
}

export function pendingItems(graph: RunGraph): WorkItem[] {
  return graph.items.filter((item) => item.status === 'pending');
}

/**
 * Pure scheduler: which pending items may start NOW.
 *
 * Invariants (enforced here, nowhere else to argue with):
 *  - dependencies are done;
 *  - plan items run strictly alone (they mutate the graph);
 *  - at most `maxParallelBuilds` build items run at once;
 *  - review items wait until no build is active (they read the diff);
 *  - deterministic order: graph order (planner's ordering is meaningful).
 */
export function selectRunnable(graph: RunGraph, opts: SelectOptions): WorkItem[] {
  const active = activeItems(graph);
  if (active.some((item) => item.kind === 'plan')) return [];

  const pending = pendingItems(graph).filter((item) => depsSatisfied(graph, item));

  // A pending plan item takes absolute priority and runs alone.
  const plan = pending.find((item) => item.kind === 'plan');
  if (plan) return active.length === 0 ? [plan] : [];

  const activeBuilds = active.filter((item) => item.kind === 'build').length;
  const selected: WorkItem[] = [];
  let buildBudget = Math.max(0, opts.maxParallelBuilds - activeBuilds);

  for (const item of pending) {
    if (item.kind === 'build') {
      if (buildBudget > 0) {
        selected.push(item);
        buildBudget -= 1;
      }
    } else if (item.kind === 'review') {
      // Reviews read a settled diff: wait for quiet, then run one at a time.
      if (active.length === 0 && selected.length === 0) {
        selected.push(item);
        break;
      }
    }
  }
  return selected;
}

/** Mark items whose dependencies can never complete as blocked (cascades). */
export function propagateDoom(graph: RunGraph): WorkItem[] {
  const changed: WorkItem[] = [];
  let dirty = true;
  while (dirty) {
    dirty = false;
    for (const item of graph.items) {
      if (item.status === 'pending' && depsDoomed(graph, item)) {
        item.status = 'blocked';
        item.error = item.error ?? 'a dependency is blocked or cancelled';
        item.endedAt = new Date().toISOString();
        changed.push(item);
        dirty = true;
      }
    }
  }
  return changed;
}

/** True when nothing can or will run anymore. */
export function isDrained(graph: RunGraph): boolean {
  return graph.items.every(
    (item) => item.status === 'done' || item.status === 'blocked' || item.status === 'cancelled',
  );
}

/** Graph-level rollup used by the run status + UI. */
export interface GraphSummary {
  total: number;
  done: number;
  blocked: number;
  cancelled: number;
  active: number;
  pending: number;
}

export function summarizeGraph(graph: RunGraph): GraphSummary {
  const summary: GraphSummary = { total: graph.items.length, done: 0, blocked: 0, cancelled: 0, active: 0, pending: 0 };
  for (const item of graph.items) {
    if (item.status === 'done') summary.done += 1;
    else if (item.status === 'blocked') summary.blocked += 1;
    else if (item.status === 'cancelled') summary.cancelled += 1;
    else if (ACTIVE_STATUSES.includes(item.status)) summary.active += 1;
    else summary.pending += 1;
  }
  return summary;
}

/** Generate a unique item id with the given prefix that is not already taken. */
export function nextItemId(graph: RunGraph, prefix: string): string {
  let index = 1;
  while (graph.items.some((item) => item.id === `${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}
