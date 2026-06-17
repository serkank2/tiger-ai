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

  /** Wait until the PTY output goes idle (UI settled), or the CLI exits, or we abort. */
  private async awaitIdle(
    st: { lastOutputTs: number; sawOutput: boolean; exit: TerminalRuntimeStatus | null },
    idleMs: number,
    minWaitMs: number,
    maxWaitMs: number,
    signal: AbortSignal,
  ): Promise<'idle' | 'exited' | 'aborted'> {
    const start = Date.now();
    while (true) {
      if (signal.aborted) return 'aborted';
      if (st.exit) return 'exited';
      const idle = Date.now() - st.lastOutputTs;
      const waited = Date.now() - start;
      if ((st.sawOutput && idle >= idleMs && waited >= minWaitMs) || waited >= maxWaitMs) return 'idle';
      await sleep(150, signal);
    }
  }

  async run(signal: AbortSignal): Promise<AgentRunResult> {
    const { manager, termId, timing } = this.o;
    // Shared mutable state updated from the manager event callbacks (held on one object so TS
    // keeps the union types across the closures).
    const st = {
      lastOutputTs: Date.now(),
      sawOutput: false,
      exit: null as TerminalRuntimeStatus | null,
    };

    const onOutput = (e: ManagerOutputEvent) => {
      if (e.termId === termId) {
        st.lastOutputTs = Date.now();
        st.sawOutput = true;
      }
    };
    const onExit = (s: TerminalRuntimeStatus) => {
      if (s.id === termId) st.exit = s;
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

      // --- wait for the CLI to finish booting (its banner/trust dialog has rendered) ---
      this.o.onState?.('waiting_ready');
      const ready = await this.awaitIdle(st, timing.readyIdleMs, 800, timing.readyMaxWaitMs, signal);
      if (ready === 'aborted') return await finish({ state: 'stopped' });
      if (ready === 'exited') {
        return await finish({
          state: 'failed',
          exitCode: st.exit?.exitCode ?? null,
          error: 'the CLI exited before it was ready for input',
        });
      }

      // --- deliver the instruction ---
      // Real CLIs (Claude/Codex) pop a one-time "Do you trust this folder?" dialog on first launch
      // and need their TUI input focused. So: (1) press Enter once — this accepts the trust dialog
      // (its default option) and primes the input; (2) wait for the UI to settle; (3) type the
      // instruction WITHOUT a newline; (4) brief pause so the box registers the text; (5) press
      // Enter to submit. Sending text+Enter in one burst (the old behavior) was dropped by the TUI.
      if (signal.aborted) return await finish({ state: 'stopped' });
      manager.write(termId, '\r'); // 1. accept trust dialog / focus input
      const settled = await this.awaitIdle(st, timing.readyIdleMs, 300, timing.settleMaxWaitMs, signal);
      if (settled === 'aborted') return await finish({ state: 'stopped' });
      // (if it 'exited' here, the completion loop below will detect the exit and validate output)

      if (!st.exit) {
        manager.write(termId, this.instruction()); // 2. + 3. type the instruction
        await sleep(timing.submitDelayMs, signal); // 4. let the input register the text
        if (signal.aborted) return await finish({ state: 'stopped' });
        manager.write(termId, '\r'); // 5. submit
      }

      this.o.onState?.('running');
      st.lastOutputTs = Date.now();
      const runStart = Date.now();
      let idleOutputCandidate: { size: number; stableSince: number; lastOutputTs: number } | null = null;

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

        const exPoll = st.exit;
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

        const idle = Date.now() - st.lastOutputTs;
        if (timing.doneIdleMs > 0 && idle >= timing.doneIdleMs) {
          const chk = await checkOutputFile(this.o.outputPath);
          if (chk.ok) {
            const now = Date.now();
            if (
              idleOutputCandidate &&
              idleOutputCandidate.size === chk.size &&
              idleOutputCandidate.lastOutputTs === st.lastOutputTs
            ) {
              if (now - idleOutputCandidate.stableSince >= timing.doneIdleMs) {
                return await finish({ state: 'completed', completion: 'idle' });
              }
            } else {
              idleOutputCandidate = { size: chk.size, stableSince: now, lastOutputTs: st.lastOutputTs };
            }
          } else {
            idleOutputCandidate = null;
          }
          // idle but no valid output yet — keep waiting until the timeout.
        } else {
          idleOutputCandidate = null;
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
