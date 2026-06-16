import type { PersistedState } from './store/types.js';
import type { TerminalManager } from './terminal/TerminalManager.js';
import type { Orchestrator } from './orchestrator/Orchestrator.js';

/** Shared application context injected into REST routers and the WS server. */
export interface AppCtx {
  state: PersistedState;
  manager: TerminalManager;
  /** Tiger multi-agent orchestrator (drives the software-team workflow). */
  orchestrator: Orchestrator;
  /** Persist the current in-memory state atomically. */
  save: () => Promise<void>;
}
