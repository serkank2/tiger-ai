import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentType } from '../orchestrator/types.js';

// ---------------------------------------------------------------------------
// SessionRegistry — the durable map from a work slot (run + role/agent key) to
// its provider session id. This is what makes v2's delta-context model work:
// a follow-up turn resumes the SAME provider session (`--resume` /
// `exec resume` / `--conversation`) and sends only the new brief, instead of
// re-transmitting the whole history like v1's compose-turn did every turn.
// Plain JSON file under the run's private directory; the engine is the single
// writer.
// ---------------------------------------------------------------------------

export interface StoredAgentSession {
  /** Stable slot key, e.g. `<runId>:<agentKey>`. */
  key: string;
  provider: AgentType;
  /** Provider session/thread/conversation id; undefined until the first turn reveals it. */
  sessionId?: string;
  /** Turns served so far (0 = the next turn is the session-opening turn). */
  turns: number;
  /**
   * The engine event sequence this session has been briefed up to. The next
   * brief includes only events with seq > lastSeq — the delta.
   */
  lastSeq: number;
  updatedAt: string;
}

interface RegistryFileShape {
  sessions: StoredAgentSession[];
}

export class SessionRegistry {
  private sessions = new Map<string, StoredAgentSession>();
  private loaded = false;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as RegistryFileShape;
      for (const session of raw.sessions ?? []) {
        if (session && typeof session.key === 'string') this.sessions.set(session.key, session);
      }
    } catch {
      // Missing or corrupt file = start fresh; sessions are recoverable state,
      // the worst case is a recap brief instead of a resume.
    }
  }

  get(key: string): StoredAgentSession | undefined {
    return this.sessions.get(key);
  }

  /** Create-or-update a slot's record and persist. */
  async upsert(
    key: string,
    provider: AgentType,
    patch: Partial<Pick<StoredAgentSession, 'sessionId' | 'lastSeq'>> & { turnServed?: boolean },
  ): Promise<StoredAgentSession> {
    const existing = this.sessions.get(key);
    const next: StoredAgentSession = {
      key,
      provider,
      sessionId: patch.sessionId ?? existing?.sessionId,
      turns: (existing?.turns ?? 0) + (patch.turnServed ? 1 : 0),
      lastSeq: patch.lastSeq ?? existing?.lastSeq ?? 0,
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(key, next);
    await this.save();
    return next;
  }

  /** Drop a slot (provider session died / was poisoned); next turn starts fresh. */
  async remove(key: string): Promise<void> {
    if (this.sessions.delete(key)) await this.save();
  }

  list(): StoredAgentSession[] {
    return [...this.sessions.values()];
  }

  private async save(): Promise<void> {
    const shape: RegistryFileShape = { sessions: this.list() };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(shape, null, 2), 'utf8');
    // Windows: rename onto an existing file can transiently EPERM under AV
    // scanning; retry briefly, then fall back to a direct (non-atomic) write —
    // session state is recoverable, losing it only costs a recap brief.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(tmp, this.file);
        return;
      } catch {
        if (attempt >= 2) {
          await fs.writeFile(this.file, JSON.stringify(shape, null, 2), 'utf8').catch(() => {});
          await fs.rm(tmp, { force: true }).catch(() => {});
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }
}
