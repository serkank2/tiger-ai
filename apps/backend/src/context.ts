import type { PersistedState } from './store/types.js';
import type { TerminalManager } from './terminal/TerminalManager.js';

/** Shared application context injected into REST routers and the WS server. */
export interface AppCtx {
  state: PersistedState;
  manager: TerminalManager;
  /** Persist the current in-memory state atomically. */
  save: () => Promise<void>;
}
