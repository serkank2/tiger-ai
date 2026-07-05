import type { PersistedState } from './store/types.js';
import type { TerminalManager } from './terminal/TerminalManager.js';
import type { PromptGenerationService } from './services/PromptGenerationService.js';
import type { QueueService } from './services/QueueService.js';
import type { LimitService } from './services/LimitService.js';
import type { RunEngine } from './run/engine.js';
import type { ProviderConfigStore } from './providers/config-store.js';

/** Shared application context injected into REST routers and the WS server. */
export interface AppCtx {
  state: PersistedState;
  manager: TerminalManager;
  /** Prompt improver workflow (headless agent turn over the v2 runtime). */
  promptGenerations: PromptGenerationService;
  /** Durable autonomous prompt queue. */
  queueService: QueueService;
  /** Provider limit snapshots and rule decisions. */
  limits: LimitService;
  /** v2 run engine (docs/REDESIGN.md): headless agent turns over a WorkGraph. */
  runEngine: RunEngine;
  /** Global provider CLI configuration (executables, models, permission modes). */
  providerConfig: ProviderConfigStore;
  /** Persist the current in-memory state atomically. */
  save: () => Promise<void>;
}
