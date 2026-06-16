import path from 'node:path';
import type { AgentType, StageId, StageMeta } from './types.js';
import { STAGE_ORDER } from './types.js';

/** Static per-stage metadata: directories, system-prompt files, output naming, context sources. */
export const STAGE_META: Record<StageId, StageMeta> = {
  'brainstorming': {
    id: 'brainstorming',
    dir: 'brainstorming',
    promptFile: '01-brainstorming.md',
    outputSuffix: 'brainstorming.md',
    title: 'Brainstorming',
    contextDirs: [],
  },
  'writing-plan': {
    id: 'writing-plan',
    dir: 'writing-plan',
    promptFile: '02-writing-plan.md',
    outputSuffix: 'plan.md',
    title: 'Writing Plan',
    contextDirs: ['brainstorming'],
  },
  'writing-tasks': {
    id: 'writing-tasks',
    dir: 'writing-tasks',
    promptFile: '03-writing-tasks.md',
    outputSuffix: 'tasks.md',
    title: 'Writing Tasks',
    contextDirs: ['brainstorming', 'writing-plan'],
  },
  'merge-tasks': {
    id: 'merge-tasks',
    dir: 'merged-tasks',
    promptFile: '04-merge-tasks.md',
    outputSuffix: 'tasks.md',
    title: 'Merge Tasks',
    contextDirs: ['writing-tasks'],
    singleAgent: true,
  },
  'executing-plan': {
    id: 'executing-plan',
    dir: 'executing-plan',
    promptFile: '05-executing-plan.md',
    outputSuffix: 'execution-log.md',
    title: 'Executing Plan',
    contextDirs: ['merged-tasks'],
  },
  'task-review': {
    id: 'task-review',
    dir: 'task-review',
    promptFile: '06-task-review.md',
    outputSuffix: 'review-log.md',
    title: 'Task Review',
    contextDirs: ['merged-tasks'],
  },
  'requesting-code-review': {
    id: 'requesting-code-review',
    dir: 'requesting-code-review',
    promptFile: '07-requesting-code-review.md',
    outputSuffix: 'code-review.md',
    title: 'Requesting Code Review',
    contextDirs: ['merged-tasks', 'executing-plan', 'task-review'],
  },
};

/** All stage directories that scaffolding must create under tiger/. */
export const STAGE_DIRS = STAGE_ORDER.map((s) => STAGE_META[s].dir);

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** A run's stable label, e.g. "claude-01". */
export function agentLabel(type: AgentType, index: number): string {
  return `${type}-${pad2(index)}`;
}

/**
 * Resolve every path of a tiger/ workspace tree from its root. `workspace` is the
 * directory the user picked; `root` is `<workspace>/tiger`.
 */
export class TigerPaths {
  readonly workspace: string;
  readonly root: string;

  constructor(workspace: string) {
    this.workspace = workspace;
    this.root = path.join(workspace, 'tiger');
  }

  get systemPromptsDir(): string {
    return path.join(this.root, 'system-prompts');
  }
  get projectPromptFile(): string {
    return path.join(this.root, 'project-prompt.md');
  }
  get configFile(): string {
    return path.join(this.root, 'config.json');
  }
  get runLogFile(): string {
    return path.join(this.root, 'run-log.md');
  }
  get mergedTasksFile(): string {
    return path.join(this.root, 'merged-tasks', 'tasks.md');
  }
  get locksDir(): string {
    return path.join(this.root, 'executing-plan', 'locks');
  }
  get finalSummaryFile(): string {
    return path.join(this.root, 'requesting-code-review', 'final-code-review-summary.md');
  }

  systemPromptFile(stage: StageId): string {
    return path.join(this.systemPromptsDir, STAGE_META[stage].promptFile);
  }
  stageDir(stage: StageId): string {
    return path.join(this.root, STAGE_META[stage].dir);
  }
  dirByName(dir: string): string {
    return path.join(this.root, dir);
  }
  runtimeDir(stage: StageId): string {
    return path.join(this.stageDir(stage), '.runtime');
  }

  /** Expected output file for a given agent run in a stage. Merge writes one fixed file. */
  outputFile(stage: StageId, type: AgentType, index: number): string {
    const meta = STAGE_META[stage];
    if (meta.singleAgent) return path.join(this.stageDir(stage), meta.outputSuffix);
    return path.join(this.stageDir(stage), `${agentLabel(type, index)}-${meta.outputSuffix}`);
  }
  markerFile(stage: StageId, runId: string): string {
    return path.join(this.runtimeDir(stage), `${runId}.done`);
  }
  promptFileFor(stage: StageId, runId: string): string {
    return path.join(this.runtimeDir(stage), `${runId}.prompt.md`);
  }
  lockFile(taskId: string): string {
    return path.join(this.locksDir, `${taskId}.lock`);
  }

  /** Path relative to the tiger root (forward-slashed) for display. */
  rel(abs: string): string {
    return path.relative(this.root, abs).replace(/\\/g, '/');
  }
}

/** All directories created during scaffolding (relative to tiger/). */
export const SCAFFOLD_DIRS: string[] = [
  'system-prompts',
  ...STAGE_DIRS,
  'executing-plan/locks',
];
