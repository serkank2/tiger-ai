import type { PersistedState } from './store/types.js';
import type { TerminalManager } from './terminal/TerminalManager.js';
import type { Orchestrator } from './orchestrator/Orchestrator.js';
import type { RunTemplateService } from './services/run-templates.js';
import type { PromptGenerationService } from './services/PromptGenerationService.js';
import type { QueueService } from './services/QueueService.js';
import type { LimitService } from './services/LimitService.js';
import type { TeamOrchestrator } from './team/TeamOrchestrator.js';
import type { TeamTemplateService } from './services/team-templates.js';
import type { TeamTranslationService } from './services/TeamTranslationService.js';

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
  /** Autonomous AI-team run engine (role agents that converse and sign off). */
  teamOrchestrator: TeamOrchestrator;
  /** DB-backed catalog of reusable team/role templates. */
  teamTemplates: TeamTemplateService;
  /** On-demand TR/EN translation of team-chat messages (agents still run in English). */
  teamTranslations: TeamTranslationService;
  /** Persist the current in-memory state atomically. */
  save: () => Promise<void>;
}
