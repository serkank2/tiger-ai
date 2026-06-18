import type { PersistedState } from './store/types.js';
import type { TerminalManager } from './terminal/TerminalManager.js';
import type { Orchestrator } from './orchestrator/Orchestrator.js';
import type { RunTemplateService } from './services/run-templates.js';
import type { PromptGenerationService } from './services/PromptGenerationService.js';
import type { QueueService } from './services/QueueService.js';
import type { LimitService } from './services/LimitService.js';

/** Shared application context injected into REST routers and the WS server. */
export interface AppCtx {
  state: PersistedState;
  manager: TerminalManager;
  /** Tiger multi-agent orchestrator (drives the software-team workflow). */
  orchestrator: Orchestrator;
  /** DB-backed global Run All template catalog. */
  runTemplates: RunTemplateService;
  /** Prompt improver workflow over the existing terminal agent path. */
  promptGenerations: PromptGenerationService;
  /** Durable autonomous prompt queue. */
  queueService: QueueService;
  /** Provider limit snapshots and rule decisions. */
  limits: LimitService;
  /** Persist the current in-memory state atomically. */
  save: () => Promise<void>;
}
