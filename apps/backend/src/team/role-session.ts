import type { TerminalManager, ManagerOutputEvent } from '../terminal/TerminalManager.js';
import type { TerminalRuntimeStatus } from '../store/types.js';
import type { AgentType, TigerTiming } from '../orchestrator/types.js';
import { checkOutputFile, markerExists } from '../orchestrator/validate.js';

// ---------------------------------------------------------------------------
// Persistent per-role CLI session. Unlike the one-shot AgentSession (which the
// Tiger pipeline uses — launch, prompt, wait, kill), a RoleCliSession launches
// the CLI ONCE and then feeds it many prompts over its lifetime, keeping the
// REPL — and therefore the agent's accumulated context — alive between turns.
// Each prompt has its own marker file; the session waits for that marker, reads
// the output, and stays running for the next prompt. The terminal is only torn
// down when the run ends or the session is explicitly closed.
// ---------------------------------------------------------------------------

export interface RoleCliSessionOptions {
  manager: TerminalManager;
  /** Stable terminal id for this role across the whole run (team-<runId>-<roleId>). */
  termId: string;
  tool: AgentType;
  timing: TigerTiming;
}

export type RolePromptState = 'completed' | 'failed' | 'stopped';

export interface RolePromptResult {
  state: RolePromptState;
  exitCode?: number | null;
  error?: string;
  /** Whether the live session is still running and ready for the next prompt. */
  alive: boolean;
}

export interface RunPromptInput {
  promptPath: string;
  outputPath: string;
  markerPath: string;
  signal: AbortSignal;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(t);
      // The abort path fires the listener; `{ once: true }` already removed it.
      resolve();
    };
    const t = setTimeout(() => {
      // The timeout path must ALSO detach the abort listener, or a tight poll loop
      // (runPrompt/awaitIdle) registers one listener per iteration that never fires,
      // leaking thousands and tripping MaxListenersExceededWarning.
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class RoleCliSession {
  private readonly o: RoleCliSessionOptions;
  private started = false;
  private listening = false;
  /** Rough running estimate of how much the agent has been fed, for compaction. */
  private feedChars = 0;
  private promptsSent = 0;

  private readonly st = {
    lastOutputTs: Date.now(),
    sawOutput: false,
    exit: null as TerminalRuntimeStatus | null,
  };

  private readonly onOutput = (e: ManagerOutputEvent): void => {
    if (e.termId === this.o.termId) {
      this.st.lastOutputTs = Date.now();
      this.st.sawOutput = true;
    }
  };
  private readonly onExit = (s: TerminalRuntimeStatus): void => {
    if (s.id === this.o.termId) this.st.exit = s;
  };

  constructor(options: RoleCliSessionOptions) {
    this.o = options;
  }

  get terminalId(): string {
    return this.o.termId;
  }

  get isAlive(): boolean {
    return this.started && !this.currentExit();
  }

  /**
   * Read the exit status through a method so TypeScript does not permanently narrow
   * `st.exit` to null after an early `if (exit) return` — the field is mutated
   * asynchronously by the exit callback, which control-flow analysis cannot see.
   */
  private currentExit(): TerminalRuntimeStatus | null {
    return this.st.exit;
  }

  /** How many prompts (turns) this session has served. */
  get turns(): number {
    return this.promptsSent;
  }

  private attach(): void {
    if (this.listening) return;
    this.o.manager.on('output', this.onOutput);
    this.o.manager.on('exit', this.onExit);
    this.listening = true;
  }

  private detach(): void {
    if (!this.listening) return;
    this.o.manager.off('output', this.onOutput);
    this.o.manager.off('exit', this.onExit);
    this.listening = false;
  }

  /** Launch the CLI once and accept its one-time trust dialog. Idempotent. */
  private async ensureStarted(signal: AbortSignal): Promise<RolePromptState> {
    if (this.started && !this.currentExit()) return 'completed';
    this.attach();
    this.st.exit = null;
    this.st.lastOutputTs = Date.now();
    this.st.sawOutput = false;
    try {
      await this.o.manager.start(this.o.termId);
    } catch (err) {
      return 'failed';
    }
    const { timing } = this.o;
    const ready = await this.awaitIdle(timing.readyIdleMs, 800, timing.readyMaxWaitMs, signal);
    if (ready === 'aborted') return 'stopped';
    if (ready === 'exited') return 'failed';
    // Accept the one-time "Do you trust this folder?" dialog and prime the input.
    if (signal.aborted) return 'stopped';
    this.o.manager.write(this.o.termId, '\r');
    await this.awaitIdle(timing.readyIdleMs, 300, timing.settleMaxWaitMs, signal);
    this.started = true;
    return 'completed';
  }

  /**
   * Feed one prompt to the live session and wait for its completion marker. The
   * CLI keeps running afterwards, retaining its context for the next prompt.
   */
  async runPrompt(input: RunPromptInput): Promise<RolePromptResult> {
    const { signal } = input;
    const start = await this.ensureStarted(signal);
    if (start !== 'completed') {
      return { state: start, error: start === 'failed' ? 'the CLI failed to start' : undefined, alive: false };
    }
    if (this.currentExit()) return { state: 'failed', error: 'the CLI exited before the prompt could be delivered', alive: false };
    if (signal.aborted) return { state: 'stopped', alive: this.isAlive };

    const { manager, termId, timing } = this.o;
    this.promptsSent += 1;
    this.st.lastOutputTs = Date.now();

    // Type the instruction (no newline), let the input register, then submit.
    manager.write(termId, this.instruction(input.promptPath));
    await sleep(timing.submitDelayMs, signal);
    if (signal.aborted) return { state: 'stopped', alive: this.isAlive };
    manager.write(termId, '\r');

    const runStart = Date.now();
    let idleCandidate: { size: number; stableSince: number; lastOutputTs: number } | null = null;

    while (true) {
      if (signal.aborted) return { state: 'stopped', alive: this.isAlive };
      await sleep(timing.markerPollMs, signal);
      if (signal.aborted) return { state: 'stopped', alive: this.isAlive };

      if (await markerExists(input.markerPath)) {
        const chk = await checkOutputFile(input.outputPath);
        return chk.ok
          ? { state: 'completed', alive: this.isAlive }
          : { state: 'failed', error: chk.reason ?? 'output invalid', alive: this.isAlive };
      }

      // An unexpected CLI exit ends the session.
      const exited = this.currentExit();
      if (exited) {
        const chk = await checkOutputFile(input.outputPath);
        return {
          state: chk.ok ? 'completed' : 'failed',
          exitCode: exited.exitCode,
          error: chk.ok ? undefined : (chk.reason ?? 'the CLI exited without producing a valid output file'),
          alive: false,
        };
      }

      // Output-idle fallback: if the deliverable is present and stable while the CLI
      // sits idle, treat the prompt as done (the agent forgot the marker).
      const idle = Date.now() - this.st.lastOutputTs;
      if (timing.doneIdleMs > 0 && idle >= timing.doneIdleMs) {
        const chk = await checkOutputFile(input.outputPath);
        if (chk.ok) {
          const now = Date.now();
          if (idleCandidate && idleCandidate.size === chk.size && idleCandidate.lastOutputTs === this.st.lastOutputTs) {
            if (now - idleCandidate.stableSince >= timing.doneIdleMs) return { state: 'completed', alive: this.isAlive };
          } else {
            idleCandidate = { size: chk.size, stableSince: now, lastOutputTs: this.st.lastOutputTs };
          }
        } else {
          idleCandidate = null;
        }
      } else {
        idleCandidate = null;
      }

      if (Date.now() - runStart >= timing.agentTimeoutMs) {
        // The CLI is still chewing on this prompt past the hard timeout. Reusing this session
        // for the next turn would let the stale, in-flight response (and its late marker)
        // bleed into the following turn, cross-attributing output. Poison the session: tear
        // the CLI down and report it dead so the pool discards it and the next turn starts a
        // fresh CLI.
        await this.dispose().catch(() => {});
        return { state: 'failed', error: 'agent timed out before signaling completion', alive: false };
      }
    }
  }

  /** Record how many characters this turn's prompt fed the session (for compaction). */
  noteFed(characters: number): void {
    this.feedChars += Math.max(0, characters);
  }

  /** Whether the accumulated context likely warrants a compaction before the next prompt. */
  shouldCompact(thresholdChars: number): boolean {
    return this.isAlive && this.promptsSent >= 2 && this.feedChars >= thresholdChars;
  }

  /**
   * Ask the live CLI to compact its own context (claude and codex both support a
   * `/compact` slash command), then wait for it to settle. Resets the local feed
   * estimate. Best-effort: never throws.
   */
  async compact(signal: AbortSignal): Promise<boolean> {
    if (!this.isAlive || signal.aborted) return false;
    // Only Claude and Codex expose a `/compact` slash command. For other CLIs (e.g.
    // Antigravity) typing `/compact` would be sent as ordinary prompt text and pollute the
    // live session, so skip compaction there until a real command is verified.
    if (this.o.tool !== 'claude' && this.o.tool !== 'codex') return false;
    try {
      this.o.manager.write(this.o.termId, '/compact');
      await sleep(this.o.timing.submitDelayMs, signal);
      this.o.manager.write(this.o.termId, '\r');
      await this.awaitIdle(this.o.timing.readyIdleMs, 500, this.o.timing.agentTimeoutMs, signal);
      this.feedChars = 0;
      return !this.currentExit();
    } catch {
      return false;
    }
  }

  /** Halt the CLI and stop listening. Use when the run ends or the session is closed. */
  async dispose(): Promise<void> {
    this.detach();
    if (this.started) {
      await this.o.manager.stop(this.o.termId).catch(() => {});
    }
    this.started = false;
  }

  private instruction(promptPath: string): string {
    return (
      `Please read the file "${promptPath}" and follow every instruction in it exactly. ` +
      `Do not ask any questions — work fully autonomously, complete the entire task, write your ` +
      `deliverable file, and then create your completion marker file as the final step.`
    );
  }

  private async awaitIdle(
    idleMs: number,
    minWaitMs: number,
    maxWaitMs: number,
    signal: AbortSignal,
  ): Promise<'idle' | 'exited' | 'aborted'> {
    const start = Date.now();
    while (true) {
      if (signal.aborted) return 'aborted';
      if (this.currentExit()) return 'exited';
      const idle = Date.now() - this.st.lastOutputTs;
      const waited = Date.now() - start;
      if ((this.st.sawOutput && idle >= idleMs && waited >= minWaitMs) || waited >= maxWaitMs) return 'idle';
      await sleep(150, signal);
    }
  }
}
