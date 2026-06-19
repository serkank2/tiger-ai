import { promises as fs } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// File-based per-agent task board. Each role gets its own inbox under the run:
//
//   .tiger/team/<runId>/agents/<roleId>/todo/        TASK-0001.json …  (assigned, queued)
//   .tiger/team/<runId>/agents/<roleId>/in-progress/ TASK-0001.json    (currently worked)
//   .tiger/team/<runId>/agents/<roleId>/done/        TASK-0001.json …  (completed)
//
// The Lead assigns work by enqueueing tasks into a role's `todo/`; the orchestrator
// claims the oldest one (FIFO), moves it to `in-progress/`, runs that role's turn,
// and moves it to `done/` on completion. Multiple tasks queue and are worked one at
// a time. The folders make the whole flow inspectable on disk and in the UI.
// ---------------------------------------------------------------------------

export type AgentTaskStatus = 'todo' | 'in-progress' | 'done';

export interface AgentTask {
  /** Stable id, zero-padded per role for FIFO ordering (TASK-0001 …). */
  id: string;
  /** Role this task is assigned to. */
  roleId: string;
  /** Role that assigned it (usually the lead/coordinator). */
  fromRoleId?: string;
  /** Short imperative title. */
  title: string;
  /** Full task description / acceptance criteria. */
  body: string;
  status: AgentTaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface RoleTaskCounts {
  todo: number;
  inProgress: number;
  done: number;
}

const STATUS_DIR: Record<AgentTaskStatus, string> = {
  'todo': 'todo',
  'in-progress': 'in-progress',
  'done': 'done',
};

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-') || 'role';
}

/** A file-based task board scoped to a single team run directory. */
export class TaskBoard {
  /** @param runDir absolute path to `.tiger/team/<runId>`. */
  constructor(private readonly runDir: string) {}

  private agentsDir(): string {
    return path.join(this.runDir, 'agents');
  }

  agentDir(roleId: string): string {
    return path.join(this.agentsDir(), safeSegment(roleId));
  }

  private statusDir(roleId: string, status: AgentTaskStatus): string {
    return path.join(this.agentDir(roleId), STATUS_DIR[status]);
  }

  /** Create the {todo,in-progress,done} folders for a role. Idempotent. */
  async ensureRole(roleId: string): Promise<void> {
    for (const status of ['todo', 'in-progress', 'done'] as AgentTaskStatus[]) {
      await fs.mkdir(this.statusDir(roleId, status), { recursive: true });
    }
  }

  /** Create folders for every role up front. */
  async init(roleIds: string[]): Promise<void> {
    for (const roleId of roleIds) await this.ensureRole(roleId);
  }

  /** The next zero-padded task id for a role (max existing + 1, across all states). */
  private async nextId(roleId: string): Promise<string> {
    let max = 0;
    for (const status of ['todo', 'in-progress', 'done'] as AgentTaskStatus[]) {
      const names = await fs.readdir(this.statusDir(roleId, status)).catch(() => [] as string[]);
      for (const name of names) {
        const m = /TASK-(\d+)\.json$/.exec(name);
        if (m) max = Math.max(max, Number(m[1]));
      }
    }
    return `TASK-${String(max + 1).padStart(4, '0')}`;
  }

  /** Assign a task to a role by writing it into the role's `todo/` queue. */
  async enqueue(input: { roleId: string; title: string; body: string; fromRoleId?: string; createdAt: string }): Promise<AgentTask> {
    await this.ensureRole(input.roleId);
    const id = await this.nextId(input.roleId);
    const task: AgentTask = {
      id,
      roleId: input.roleId,
      fromRoleId: input.fromRoleId,
      title: input.title.slice(0, 200),
      body: input.body,
      status: 'todo',
      createdAt: input.createdAt,
    };
    await this.write('todo', task);
    return task;
  }

  private file(status: AgentTaskStatus, task: Pick<AgentTask, 'roleId' | 'id'>): string {
    return path.join(this.statusDir(task.roleId, status), `${task.id}.json`);
  }

  private async write(status: AgentTaskStatus, task: AgentTask): Promise<void> {
    await fs.mkdir(this.statusDir(task.roleId, status), { recursive: true });
    await fs.writeFile(this.file(status, task), JSON.stringify({ ...task, status }, null, 2), 'utf8');
  }

  private async list(roleId: string, status: AgentTaskStatus): Promise<AgentTask[]> {
    const dir = this.statusDir(roleId, status);
    const names = (await fs.readdir(dir).catch(() => [] as string[]))
      .filter((n) => n.endsWith('.json'))
      .sort(); // TASK-0001 < TASK-0002 → FIFO
    const out: AgentTask[] = [];
    for (const name of names) {
      const raw = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '');
      try {
        const parsed = JSON.parse(raw) as AgentTask;
        if (parsed && typeof parsed.id === 'string') out.push({ ...parsed, status });
      } catch {
        // ignore a corrupt task file
      }
    }
    return out;
  }

  listTodo(roleId: string): Promise<AgentTask[]> {
    return this.list(roleId, 'todo');
  }

  listInProgress(roleId: string): Promise<AgentTask[]> {
    return this.list(roleId, 'in-progress');
  }

  /** Claim the oldest queued task for a role: move todo → in-progress. Null if none. */
  async claimNext(roleId: string, now: string): Promise<AgentTask | null> {
    const todo = await this.listTodo(roleId);
    const task = todo[0];
    if (!task) return null;
    const moved: AgentTask = { ...task, status: 'in-progress', startedAt: now };
    await this.write('in-progress', moved);
    await fs.rm(this.file('todo', task), { force: true });
    return moved;
  }

  /** Mark an in-progress task done: move in-progress → done. */
  async complete(task: AgentTask, now: string): Promise<void> {
    const moved: AgentTask = { ...task, status: 'done', completedAt: now };
    await this.write('done', moved);
    await fs.rm(this.file('in-progress', task), { force: true });
  }

  /** Return an in-progress task back to the queue (e.g. its turn failed): in-progress → todo. */
  async requeue(task: AgentTask): Promise<void> {
    const moved: AgentTask = { ...task, status: 'todo', startedAt: undefined };
    await this.write('todo', moved);
    await fs.rm(this.file('in-progress', task), { force: true });
  }

  /**
   * Return every role's `in-progress/` task to its `todo/` queue. Used on boot/resume: a
   * task left in-progress by a crashed or interrupted run would otherwise block forever
   * (it can never reach `done`, so the completion gate's board check never clears). Returns
   * how many tasks were requeued.
   */
  async requeueInProgress(roleIds: string[]): Promise<number> {
    let requeued = 0;
    for (const roleId of roleIds) {
      for (const task of await this.listInProgress(roleId)) {
        await this.requeue(task);
        requeued += 1;
      }
    }
    return requeued;
  }

  /** All task titles for a role across every state (used to dedupe re-assignments). */
  async titles(roleId: string): Promise<Set<string>> {
    const all = await Promise.all([
      this.list(roleId, 'todo'),
      this.list(roleId, 'in-progress'),
      this.list(roleId, 'done'),
    ]);
    return new Set(all.flat().map((task) => task.title));
  }

  async counts(roleId: string): Promise<RoleTaskCounts> {
    const [todo, inProgress, done] = await Promise.all([
      this.list(roleId, 'todo'),
      this.list(roleId, 'in-progress'),
      this.list(roleId, 'done'),
    ]);
    return { todo: todo.length, inProgress: inProgress.length, done: done.length };
  }

  /** True when no role has any queued or in-progress task. */
  async allQueuesClear(roleIds: string[]): Promise<boolean> {
    for (const roleId of roleIds) {
      const c = await this.counts(roleId);
      if (c.todo > 0 || c.inProgress > 0) return false;
    }
    return true;
  }
}
