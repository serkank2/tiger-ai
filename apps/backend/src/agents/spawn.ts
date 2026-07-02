import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../obs/logger.js';

// ---------------------------------------------------------------------------
// Windows-safe, shell-free process spawning for headless agent turns.
//
// v1 launched agents by writing a shell command line into a PTY. v2 spawns the
// CLI directly with discrete argv tokens (no shell, no quoting ambiguity, no
// injection surface). The one platform wrinkle: on Windows, `spawn` without a
// shell can only execute real executables (.exe/.com) — npm `.cmd` shims need
// a `cmd.exe /c` trampoline, which re-tokenizes arguments and breaks embedded
// JSON. So we resolve the command against PATH ourselves, PREFERRING a native
// .exe, and only fall back to the cmd.exe trampoline (with a warning) when a
// batch shim is all that exists.
// ---------------------------------------------------------------------------

export interface ResolvedCommand {
  /** Absolute path (or original name when resolution failed and we let spawn try). */
  file: string;
  /** True when the target is a .cmd/.bat batch shim that needs cmd.exe. */
  isBatch: boolean;
}

/** Resolve `command` against PATH, preferring native executables over batch shims. */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): ResolvedCommand {
  if (process.platform !== 'win32') return { file: command, isBatch: false };
  const hasSep = command.includes('/') || command.includes('\\');
  const exts = ['.exe', '.com', '.cmd', '.bat'];
  const hasKnownExt = exts.some((ext) => command.toLowerCase().endsWith(ext));

  const candidatePaths = (base: string): string[] =>
    hasKnownExt ? [base] : [base + '.exe', base + '.com', base + '.cmd', base + '.bat'];

  const dirs = hasSep ? [''] : (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const base = hasSep ? command : path.join(dir, command);
    for (const candidate of candidatePaths(base)) {
      if (existsSync(candidate)) {
        const lower = candidate.toLowerCase();
        return { file: candidate, isBatch: lower.endsWith('.cmd') || lower.endsWith('.bat') };
      }
    }
  }
  // Let spawn produce the ENOENT with the original name (clearer error).
  return { file: command, isBatch: false };
}

export interface SpawnAgentOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/** Spawn a headless agent process with piped stdio and no shell. */
export function spawnAgentProcess(command: string, args: string[], opts: SpawnAgentOptions): ChildProcess {
  const env = { ...process.env, ...opts.env };
  const resolved = resolveCommand(command, env);

  if (resolved.isBatch) {
    // Batch shims re-expand %* — embedded quotes in JSON args can break. Native
    // installs of claude/codex/agy are all .exe; this path exists for npm shims.
    logger.warn('agent CLI resolved to a batch shim; spawning via cmd.exe (prefer a native install for reliability)', {
      command: resolved.file,
    });
    return spawn('cmd.exe', ['/d', '/s', '/c', resolved.file, ...args], {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Let Node quote each token; cmd re-tokenizes but simple tokens survive.
      windowsVerbatimArguments: false,
    });
  }

  return spawn(resolved.file, args, {
    cwd: opts.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/**
 * Kill a process AND its descendants. Agent CLIs spawn their own children
 * (shell commands, LSPs); on Windows `child.kill()` alone leaves them running,
 * so use `taskkill /T`. Best-effort: never throws.
 */
export async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
    return;
  }
  try {
    // Negative pid = process group when detached; fall back to direct kill.
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}
