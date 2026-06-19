/**
 * Cue — an event-driven orchestration engine ("wake agents into self-running pipelines").
 *
 * A *subscription* binds an EVENT (a file change, a schedule tick, an agent completing, or a
 * manual CLI trigger) to a TARGET ACTION (enqueue a queue job, or steer the running team).
 * When the event fires and the optional FILTER matches, the subscription's prompt template is
 * rendered with payload vars and dispatched to its target.
 *
 * Everything in this module is config-gated (OFF by default) and additive: nothing here runs
 * unless `config.cue.enabled` is set, so a normal boot is byte-for-byte unchanged.
 */

/** The event kinds Cue can subscribe to. */
export type CueEventType =
  | 'file.changed'
  | 'time.scheduled'
  | 'time.once'
  | 'agent.completed'
  | 'cli.trigger';

/** A filesystem change kind, mirrored from `node:fs.watch`'s eventType plus a derived 'deleted'. */
export type CueChangeType = 'created' | 'modified' | 'deleted' | 'any';

/** Which orchestrator produced an `agent.completed` event. */
export type CueAgentSource = 'team' | 'tiger';

/**
 * Optional per-event match filter. Unset fields are wildcards. The shape is a superset across
 * event types; only the fields relevant to a subscription's `event` are consulted.
 */
export interface CueFilter {
  /** file.changed: restrict to a change kind. */
  changeType?: CueChangeType;
  /** file.changed: only fire when the changed path matches this substring or glob-ish suffix. */
  pathIncludes?: string;
  /** agent.completed: only fire when the completion came from this source. */
  triggeredBy?: CueAgentSource;
  /**
   * agent.completed fan-in: wait until ALL of these named sources have completed (since the last
   * fire) before triggering once. A "source name" is the team runId or the Tiger stage id.
   */
  allOf?: string[];
}

/** Where a fired subscription routes its rendered prompt. */
export type CueTargetKind = 'queue' | 'team';

export interface CueTarget {
  kind: CueTargetKind;
  /** queue: optional workspace path / project name / provider for the enqueued job. */
  workspacePath?: string;
  projectName?: string;
  provider?: 'claude' | 'codex' | 'antigravity' | 'mixed';
  priority?: number;
  maxAttempts?: number;
}

/** A single declarative subscription as authored in `.kaplan/cue.json`. */
export interface CueSubscription {
  id: string;
  /** Optional human label for the UI. */
  name?: string;
  event: CueEventType;
  filter?: CueFilter;
  /** Inline prompt template. Exactly one of `prompt` / `promptFile` must be present. */
  prompt?: string;
  /** Path (relative to the workspace) to a file whose contents are the prompt template. */
  promptFile?: string;
  target: CueTarget;
  /** Subscription is inert when false. Defaults to true. */
  enabled?: boolean;
  /**
   * file.changed: dir (relative to workspace) to watch recursively. Defaults to '.'.
   * time.scheduled: interval spec, e.g. "30s", "5m", "1h" (a simple, dependency-free spec).
   * time.once: ISO timestamp at which to fire once, then self-disable.
   */
  watch?: string;
  intervalMs?: number;
  at?: string;
}

/** The whole per-project config file. */
export interface CueConfigFile {
  subscriptions: CueSubscription[];
}

/** Runtime payload handed to template rendering + the target dispatcher when an event fires. */
export interface CueEventPayload {
  event: CueEventType;
  /** file.changed: absolute path of the changed file. */
  filePath?: string;
  changeType?: CueChangeType;
  /** agent.completed: who finished + a (truncated) summary of their output. */
  source?: string;
  sourceOutput?: string;
  /** Free-form extras merged into template vars. */
  extra?: Record<string, string>;
}

/** Per-subscription runtime status surfaced over REST/UI. */
export interface CueSubscriptionStatus {
  id: string;
  name: string | null;
  event: CueEventType;
  target: CueTargetKind;
  enabled: boolean;
  /** ISO timestamp of the last successful fire, or null. */
  lastFiredAt: string | null;
  /** How many times this subscription has fired since the engine started. */
  fireCount: number;
  /** Last error message (render/dispatch failure), or null. */
  lastError: string | null;
  /** For fan-in subscriptions: which named sources are still outstanding. */
  pendingSources?: string[];
}

/** Engine status surfaced over REST/UI. */
export interface CueEngineStatus {
  enabled: boolean;
  running: boolean;
  workspace: string | null;
  configPath: string | null;
  subscriptions: CueSubscriptionStatus[];
}
