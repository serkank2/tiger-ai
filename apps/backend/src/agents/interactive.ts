import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { CliToolConfig } from '../orchestrator/types.js';
import { logger } from '../obs/logger.js';
import { agentEvent, type AgentEvent } from './events.js';
import { parseTurnResult, type TurnResult } from './result.js';
import { resolveCommand } from './spawn.js';
import type { AgentTurnReport } from './runner.js';
import type { AgentType } from '../orchestrator/types.js';

// ---------------------------------------------------------------------------
// Interactive turn runner — the opt-in alternative to the headless one-shot.
//
// Instead of `claude -p` / `codex exec`, this launches the provider's REAL
// interactive CLI in a PTY: the user watches the live TUI, types into it, and
// runs `/compact` to manage context themselves. The engine seeds the task
// brief as the first input and then gets out of the way.
//
// Turn completion is DRIVEN, never guessed — no idle heuristics, no
// scrape-the-scrollback (the v1 failure modes). A turn ends when EITHER:
//   - the agent writes its final structured result to KAPLAN_RESULT_FILE
//     (the reliable, TUI-proof signal the brief asks for), OR
//   - the user clicks "complete turn" in the UI (controller.complete()), OR
//   - the user aborts, OR the hard timeout fires.
// The PTY output streams out as AgentEvents so the run's terminal panel is the
// live CLI; keystrokes route back in through controller.write().
// ---------------------------------------------------------------------------

/** Minimal PTY surface (node-pty's IPty subset) — injectable so tests need no real TTY. */
export interface InteractivePty {
  write(data: string): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void };
  kill(signal?: string): void;
}

export type InteractivePtySpawn = (
  file: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; cols: number; rows: number },
) => InteractivePty;

export interface InteractiveTurnOptions {
  provider: AgentType;
  tool: CliToolConfig;
  /** Composed brief (preamble + task) seeded as the first input. */
  prompt: string;
  model?: string;
  effort?: string;
  /** Built-in permission-mode key (looked up in tool.permissionModes). */
  permission?: string;
  allowDangerous: boolean;
  cwd: string;
  /** Directory for the turn's result file (KAPLAN_RESULT_FILE). */
  scratchDir: string;
  hardTimeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  /** Injected for tests; defaults to the real node-pty spawn. */
  ptySpawn?: InteractivePtySpawn;
  /** How often to poll the result file (ms). */
  pollMs?: number;
  /** Delay before seeding the brief, to let the TUI come up (ms). */
  seedDelayMs?: number;
}

/** A live interactive turn: route input, complete, or abort it from the outside. */
export interface InteractiveTurnController {
  readonly promise: Promise<AgentTurnReport>;
  /** Route a user keystroke/line into the live CLI. */
  write(data: string): void;
  /** User signals the turn is finished — the engine reads the result file (if any). */
  complete(): void;
  /** Abort the turn (stop / steering interrupt). */
  abort(reason?: string): void;
}

// CSI + simple escape sequences, plus BEL/CR — built via new RegExp so the
// source file carries no raw control bytes.
const ANSI = new RegExp('\\u001b(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])|[\\u0007\\r]', 'g');

/** Strip ANSI/CSI sequences so the streamed TUI reads as plain text in the panel. */
function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Interactive argv for a provider CLI (NO headless `-p`/`exec` flag). */
function buildInteractiveArgs(opts: InteractiveTurnOptions): string[] {
  const { tool, provider } = opts;
  const args: string[] = [];
  const model = opts.model?.trim();
  if (model && tool.modelFlag) args.push(tool.modelFlag, model);
  // Effort: claude takes a flag; codex takes a -c config key; agy has none.
  const effort = opts.effort?.trim();
  if (effort) {
    if (tool.effortFlag) args.push(tool.effortFlag, effort);
    else if (tool.effortConfigKey) args.push('-c', `${tool.effortConfigKey}=${effort}`);
  }
  // Permission argv from the same built-in modes the headless path uses.
  const permKey = opts.permission?.trim();
  const modes = tool.permissionModes ?? {};
  const chosen = permKey && modes[permKey] ? modes[permKey] : undefined;
  if (chosen && (opts.allowDangerous || !isDangerousMode(provider, permKey))) {
    args.push(...chosen);
  }
  return args;
}

/** Whether a permission key is the fully-unrestricted one (gated behind allowDangerous). */
function isDangerousMode(provider: AgentType, key: string | undefined): boolean {
  if (!key) return false;
  if (provider === 'claude' || provider === 'antigravity') return key === 'dangerous';
  if (provider === 'codex') return key === 'yolo';
  return false;
}

const RESULT_FILENAME = 'interactive-result.json';

function resultInstruction(resultFile: string): string {
  return (
    `\n\n---\nINTERACTIVE SESSION. You are running in a real terminal a human is watching and may type into. ` +
    `Use \`/compact\` yourself when the context grows large. When — and only when — you have FULLY finished this task, ` +
    `write your final structured result as JSON to this exact file:\n${resultFile}\n` +
    `(e.g. \`{"status":"done","summary":"..."}\` for a task, or the plan JSON for a plan). ` +
    `Writing that file signals completion; until then keep working or wait for input.`
  );
}

/**
 * Launch an interactive PTY turn and return a controller. The returned
 * `promise` resolves to a normalized AgentTurnReport when the turn completes,
 * fails, or is aborted — mirroring the headless runner's contract so the engine
 * treats both paths identically.
 */
export function runInteractiveTurn(opts: InteractiveTurnOptions): InteractiveTurnController {
  const startedAt = Date.now();
  const resultFile = path.join(opts.scratchDir, RESULT_FILENAME);
  const pollMs = opts.pollMs ?? 1500;

  let settled = false;
  let resolveFn!: (report: AgentTurnReport) => void;
  const promise = new Promise<AgentTurnReport>((resolve) => {
    resolveFn = resolve;
  });

  let pty: InteractivePty | null = null;
  let dataDisp: { dispose(): void } | null = null;
  let exitDisp: { dispose(): void } | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let eventCount = 0;

  const emit = (event: AgentEvent): void => {
    eventCount += 1;
    try {
      opts.onEvent?.(event);
    } catch {
      /* the sink must never break the turn */
    }
  };

  const cleanup = (): void => {
    dataDisp?.dispose();
    exitDisp?.dispose();
    if (poll) clearInterval(poll);
    if (timeout) clearTimeout(timeout);
    poll = timeout = null;
    try {
      pty?.kill();
    } catch {
      /* already gone */
    }
  };

  const finish = (
    state: AgentTurnReport['state'],
    result: TurnResult | null,
    resultText: string | undefined,
    error?: string,
  ): void => {
    if (settled) return;
    settled = true;
    cleanup();
    if (state !== 'completed') {
      logger.warn('interactive turn did not complete', { provider: opts.provider, state, error });
    }
    resolveFn({
      state,
      exitCode: state === 'completed' ? 0 : null,
      resultText,
      result,
      eventCount,
      durationMs: Date.now() - startedAt,
      command: `${opts.tool.executable} (interactive)`,
      error,
    });
  };

  /** Read + parse the result file; returns null when absent/empty/invalid. */
  const readResult = async (): Promise<{ text: string; parsed: TurnResult | null } | null> => {
    const text = await fs.readFile(resultFile, 'utf8').catch(() => '');
    if (!text.trim()) return null;
    return { text: text.trim(), parsed: parseTurnResult(text) };
  };

  const controller: InteractiveTurnController = {
    promise,
    write: (data) => {
      try {
        pty?.write(data);
      } catch {
        /* pty gone */
      }
    },
    complete: () => {
      void readResult().then((found) => {
        // Prefer the agent's own structured result; if the user completed
        // without one, honor their judgment with a generic done result.
        if (found?.parsed) finish('completed', found.parsed, found.text);
        else finish('completed', { status: 'done', summary: 'Interactively completed by the user.' }, found?.text);
      });
    },
    abort: (reason) => finish('stopped', null, undefined, reason ?? 'interactive turn aborted'),
  };

  // --- launch ---------------------------------------------------------------
  void (async () => {
    if (opts.signal?.aborted) {
      finish('stopped', null, undefined, 'aborted before start');
      return;
    }
    try {
      await fs.mkdir(opts.scratchDir, { recursive: true });
      await fs.rm(resultFile, { force: true }).catch(() => {});
    } catch {
      /* best-effort */
    }

    const spawn = opts.ptySpawn ?? defaultPtySpawn;
    const env = Object.fromEntries(
      Object.entries({ ...process.env, KAPLAN_RESULT_FILE: resultFile }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    try {
      pty = spawn(opts.tool.executable, buildInteractiveArgs(opts), { cwd: opts.cwd, env, cols: 120, rows: 32 });
    } catch (err) {
      finish('failed', null, undefined, `failed to launch interactive ${opts.tool.executable}: ${errMsg(err)}`);
      return;
    }

    emit(agentEvent.turnStarted());
    dataDisp = pty.onData((data) => {
      const text = stripAnsi(data);
      if (text.trim()) emit(agentEvent.text(text));
    });
    exitDisp = pty.onExit(async ({ exitCode }) => {
      // The interactive CLI exited (user typed /exit or it closed): the result
      // file is the truth if present, else the exit stands as the outcome.
      const found = await readResult();
      if (found?.parsed) finish('completed', found.parsed, found.text);
      else if (exitCode === 0)
        finish('completed', { status: 'done', summary: 'Interactive session ended.' }, found?.text);
      else finish('failed', null, found?.text, `interactive CLI exited with code ${exitCode}`);
    });

    opts.signal?.addEventListener('abort', () => controller.abort('run stopped'), { once: true });

    // Seed the brief once the TUI has had a moment to come up.
    const seed = opts.prompt + resultInstruction(resultFile);
    setTimeout(() => {
      if (settled) return;
      try {
        pty?.write(seed + '\r');
      } catch {
        /* pty gone */
      }
    }, opts.seedDelayMs ?? 600);

    // Poll the result file — the agent writing it means "done".
    poll = setInterval(() => {
      void readResult().then((found) => {
        if (found?.parsed) finish('completed', found.parsed, found.text);
      });
    }, pollMs);

    timeout = setTimeout(() => {
      finish(
        'failed',
        null,
        undefined,
        `interactive turn exceeded the hard timeout (${Math.round(opts.hardTimeoutMs / 60_000)} min)`,
      );
    }, opts.hardTimeoutMs);
  })();

  return controller;
}

/**
 * Resolve a bare CLI name to what node-pty must actually spawn. node-pty does
 * NOT search PATH (unlike child_process on POSIX), and on Windows it cannot run
 * a `.cmd` shim directly — so a bare `codex`/`claude`/`agy` fails with
 * "Cannot create process, error code: 2" (ENOENT). We reuse the headless
 * resolver: prefer the real `.exe`, and trampoline a batch shim through cmd.exe.
 */
export function resolvePtyCommand(
  file: string,
  args: string[],
  env: Record<string, string>,
): { command: string; args: string[] } {
  const resolved = resolveCommand(file, env);
  if (resolved.isBatch) {
    const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
    return { command: comspec, args: ['/d', '/s', '/c', resolved.file, ...args] };
  }
  return { command: resolved.file, args };
}

// node-pty is a native module loaded LAZILY (only when an interactive turn
// actually spawns) so headless runs and backend boot never hard-depend on it.
const requireCjs = createRequire(import.meta.url);
let ptyModule: typeof import('node-pty') | null = null;
function loadPty(): typeof import('node-pty') {
  return (ptyModule ??= requireCjs('node-pty') as typeof import('node-pty'));
}

/** Real node-pty spawn — the default backing for a live interactive turn. */
const defaultPtySpawn: InteractivePtySpawn = (file, args, opts) => {
  const { command, args: spawnArgs } = resolvePtyCommand(file, args, opts.env);
  const proc = loadPty().spawn(command, spawnArgs, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: opts.env,
  });
  return {
    write: (data) => proc.write(data),
    onData: (cb) => proc.onData(cb),
    onExit: (cb) => proc.onExit(({ exitCode }) => cb({ exitCode })),
    kill: (signal) => proc.kill(signal),
  };
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
