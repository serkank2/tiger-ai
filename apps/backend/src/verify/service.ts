import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { killProcessTree, spawnAgentProcess } from '../agents/spawn.js';
import { logger } from '../obs/logger.js';

// ---------------------------------------------------------------------------
// VerificationService — Kaplan runs the checks itself.
//
// v1 asked agents to report whether builds/tests passed (a `VerificationDirective`
// written into a file), which cost an agent turn per check and was only as
// honest as the agent. v2 removes the middleman: the engine invokes this
// service after every build step; the ONLY source of "passed" anywhere in the
// system is an exit code observed here. Commands are discrete argv tokens
// (no shell strings), mirroring the git/write.ts discipline.
// ---------------------------------------------------------------------------

export interface VerificationCommand {
  /** Stable id (e.g. "typecheck", "test-backend"). */
  id: string;
  /** Executable + argv, spawned without a shell (npm shims are trampolined safely). */
  command: string;
  args: string[];
  /** Hard ceiling; default 10 minutes. */
  timeoutMs?: number;
}

export type VerificationOutcome = 'passed' | 'failed' | 'timeout' | 'error';

export interface VerificationRecord {
  id: string;
  /** Human-readable invocation (argv joined). */
  command: string;
  outcome: VerificationOutcome;
  exitCode: number | null;
  durationMs: number;
  /** Last lines of combined output — enough context to brief a fix task. */
  outputTail: string;
  at: string;
}

export interface VerifyRunOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Stop at the first failing command (default true — later checks usually just add noise). */
  stopOnFailure?: boolean;
  /** Max lines retained per command output tail (default 60). */
  tailLines?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export class VerificationService {
  /** Run the given checks sequentially; every record is persisted truth. */
  async run(commands: VerificationCommand[], opts: VerifyRunOptions): Promise<VerificationRecord[]> {
    const records: VerificationRecord[] = [];
    for (const command of commands) {
      if (opts.signal?.aborted) break;
      const record = await this.runOne(command, opts);
      records.push(record);
      if (record.outcome !== 'passed' && (opts.stopOnFailure ?? true)) break;
    }
    return records;
  }

  private async runOne(command: VerificationCommand, opts: VerifyRunOptions): Promise<VerificationRecord> {
    const startedAt = Date.now();
    const commandLine = [command.command, ...command.args].join(' ');
    const tailLimit = opts.tailLines ?? 60;
    const tail: string[] = [];
    const keep = (line: string): void => {
      const text = line.trimEnd();
      if (!text.trim()) return;
      tail.push(text);
      if (tail.length > tailLimit) tail.shift();
    };

    let child: ReturnType<typeof spawnAgentProcess>;
    try {
      child = spawnAgentProcess(command.command, command.args, { cwd: opts.cwd });
    } catch (err) {
      return this.record(command.id, commandLine, 'error', null, startedAt, String(err));
    }

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      void killProcessTree(child);
    }, command.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = (): void => void killProcessTree(child);
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    if (child.stdout) readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', keep);
    if (child.stderr) readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', keep);
    child.stdin?.on('error', () => {}); // ignore broken-pipe on early exit
    child.stdin?.end();

    const { exitCode, spawnError } = await new Promise<{ exitCode: number | null; spawnError?: string }>((resolve) => {
      child.once('error', (err) => resolve({ exitCode: null, spawnError: err.message }));
      child.once('close', (code) => resolve({ exitCode: code }));
    });

    clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onAbort);

    const output = tail.join('\n');
    if (spawnError) return this.record(command.id, commandLine, 'error', exitCode, startedAt, spawnError);
    if (timedOut) return this.record(command.id, commandLine, 'timeout', exitCode, startedAt, output);
    const outcome: VerificationOutcome = exitCode === 0 ? 'passed' : 'failed';
    if (outcome === 'failed') {
      logger.info('verification failed', { id: command.id, exitCode });
    }
    return this.record(command.id, commandLine, outcome, exitCode, startedAt, output);
  }

  private record(
    id: string,
    command: string,
    outcome: VerificationOutcome,
    exitCode: number | null,
    startedAt: number,
    outputTail: string,
  ): VerificationRecord {
    return {
      id,
      command,
      outcome,
      exitCode,
      durationMs: Date.now() - startedAt,
      outputTail: outputTail.slice(-8000),
      at: new Date().toISOString(),
    };
  }
}

/**
 * Discover sensible default checks from the workspace's package.json scripts.
 * Order matters: cheap static checks first, tests after.
 */
export async function discoverVerificationCommands(workspace: string): Promise<VerificationCommand[]> {
  const preferred = ['typecheck', 'lint', 'test', 'build'];
  try {
    const raw = JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    const scripts = raw.scripts ?? {};
    return preferred
      .filter((name) => typeof scripts[name] === 'string')
      .map((name) => ({ id: name, command: 'npm', args: ['run', '--silent', name] }));
  } catch {
    return [];
  }
}

/**
 * The cheap static subset (typecheck/lint) used as the per-build gate. Tests
 * and builds stay in the FULL set that runs at finalize — running the whole
 * suite after every build task dominates wall-clock on large graphs.
 */
export async function discoverQuickVerificationCommands(workspace: string): Promise<VerificationCommand[]> {
  const all = await discoverVerificationCommands(workspace);
  return all.filter((command) => command.id === 'typecheck' || command.id === 'lint');
}
