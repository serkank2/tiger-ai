import type { TerminalManager, ManagerOutputEvent } from '../terminal/TerminalManager.js';
import type { TerminalRuntimeStatus } from '../store/types.js';
import type { AgentRunState, CompletionMethod, TigerTiming } from './types.js';
import { checkOutputFile, markerExists } from './validate.js';

export interface AgentRunResult {
  state: 'completed' | 'failed' | 'stopped';
  completion?: CompletionMethod;
  exitCode?: number | null;
  error?: string;
}

export interface AgentSessionOptions {
  manager: TerminalManager;
  /** Ephemeral terminal id (also the run id used by the live xterm tile). */
  termId: string;
  label: string;
  /** Launch command typed into the shell (e.g. "claude --permission-mode acceptEdits"). */
  command: string;
  /** Working directory for the agent (the tiger root). */
  cwd: string;
  /** Prompt file the agent is instructed to read. */
  promptPath: string;
  /** Expected deliverable output file. */
  outputPath: string;
  /** Completion marker the agent is instructed to create as its final action. */
  markerPath: string;
  timing: TigerTiming;
  /** Notified on run-state transitions so the UI can update live. */
  onState?: (s: AgentRunState) => void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Drives a single interactive Claude/Codex agent over the shared TerminalManager:
 * launches the real CLI in a PTY, waits for it to become ready, types a one-line
 * instruction pointing at the composed prompt file, then detects completion via the
 * agent's `.done` marker (primary), an output-idle fallback, an unexpected CLI exit,
 * or a hard timeout. The live PTY output streams to the UI through the existing term.*
 * WebSocket path; this class only handles lifecycle + completion detection.
 */
export class AgentSession {
  constructor(private readonly o: AgentSessionOptions) {}

  private instruction(): string {
    return (
      `Please read the file "${this.o.promptPath}" and follow every instruction in it exactly. ` +
      `Do not ask any questions — work fully autonomously, complete the entire task, write your ` +
      `deliverable file, and then create your completion marker file as the final step.`
    );
  }

  async run(signal: AbortSignal): Promise<AgentRunResult> {
    const { manager, termId, timing } = this.o;
    let lastOutputTs = Date.now();
    let sawOutput = false;
    // Held on an object: a `let` reassigned only inside a closure gets narrowed by TS to its
    // initializer type (null), which then breaks property access at the read sites.
    const exitBox: { value: TerminalRuntimeStatus | null } = { value: null };

    const onOutput = (e: ManagerOutputEvent) => {
      if (e.termId === termId) {
        lastOutputTs = Date.now();
        sawOutput = true;
      }
    };
    const onExit = (s: TerminalRuntimeStatus) => {
      if (s.id === termId) exitBox.value = s;
    };
    manager.on('output', onOutput);
    manager.on('exit', onExit);

    const finish = async (r: AgentRunResult): Promise<AgentRunResult> => {
      // The work is over (or aborted) — halt the CLI but keep the session so its
      // scrollback stays viewable in the tile. The orchestrator removes it later.
      await manager.stop(termId).catch(() => {});
      return r;
    };

    try {
      // The ephemeral terminal definition is registered by the orchestrator before the run
      // becomes visible, so the live tile can attach immediately. Just start it here.
      this.o.onState?.('starting');
      try {
        await manager.start(termId);
      } catch (err) {
        return await finish({ state: 'failed', error: `failed to launch CLI: ${msg(err)}` });
      }

      // --- wait for the CLI to be ready for input ---
      this.o.onState?.('waiting_ready');
      const readyStart = Date.now();
      while (true) {
        if (signal.aborted) return await finish({ state: 'stopped' });
        const exReady = exitBox.value;
        if (exReady) {
          return await finish({
            state: 'failed',
            exitCode: exReady.exitCode,
            error: 'the CLI exited before it was ready for input',
          });
        }
        const idle = Date.now() - lastOutputTs;
        const waited = Date.now() - readyStart;
        if ((sawOutput && idle >= timing.readyIdleMs && waited >= 800) || waited >= timing.readyMaxWaitMs) break;
        await sleep(200, signal);
      }

      // --- send the instruction ---
      if (signal.aborted) return await finish({ state: 'stopped' });
      manager.write(termId, this.instruction() + '\r');
      this.o.onState?.('running');
      lastOutputTs = Date.now();
      const runStart = Date.now();

      // --- detect completion ---
      while (true) {
        if (signal.aborted) return await finish({ state: 'stopped' });
        await sleep(timing.markerPollMs, signal);
        if (signal.aborted) return await finish({ state: 'stopped' });

        if (await markerExists(this.o.markerPath)) {
          const chk = await checkOutputFile(this.o.outputPath);
          return await finish(
            chk.ok
              ? { state: 'completed', completion: 'marker' }
              : { state: 'failed', completion: 'marker', error: chk.reason ?? 'output invalid' },
          );
        }

        const exPoll = exitBox.value;
        if (exPoll) {
          const chk = await checkOutputFile(this.o.outputPath);
          return await finish(
            chk.ok
              ? { state: 'completed', completion: 'exit', exitCode: exPoll.exitCode }
              : {
                  state: 'failed',
                  completion: 'exit',
                  exitCode: exPoll.exitCode,
                  error: chk.reason ?? 'the CLI exited without producing a valid output file',
                },
          );
        }

        const idle = Date.now() - lastOutputTs;
        if (timing.doneIdleMs > 0 && idle >= timing.doneIdleMs) {
          const chk = await checkOutputFile(this.o.outputPath);
          if (chk.ok) return await finish({ state: 'completed', completion: 'idle' });
          // idle but no valid output yet — keep waiting until the timeout.
        }

        if (Date.now() - runStart >= timing.agentTimeoutMs) {
          return await finish({ state: 'failed', error: 'agent timed out before signaling completion' });
        }
      }
    } finally {
      manager.off('output', onOutput);
      manager.off('exit', onExit);
    }
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
