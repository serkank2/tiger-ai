import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config as appConfig } from '../config.js';
import type { LimitGate } from '../limits/gate.js';
import { StateLimitGate } from '../limits/gate.js';
import { AgentSession } from '../orchestrator/AgentSession.js';
import { buildLaunchCommand } from '../orchestrator/launch-command.js';
import type { AgentRunState, AgentType, TigerConfig, TigerTiming } from '../orchestrator/types.js';
import { defaultTigerConfig, effortsForProvider, isLaunchSafeModel } from '../orchestrator/config.js';
import type { TerminalManager } from '../terminal/TerminalManager.js';
import type { TerminalDefinition } from '../store/types.js';
import type { PersistedState } from '../store/types.js';
import {
  MySqlPromptGenerationRepository,
  type PromptGenerationRecord,
  type PromptGenerationRepository,
} from '../repositories/PromptGenerationRepository.js';
import {
  MySqlPromptHistoryRepository,
  type PromptHistoryFilters,
  type PromptHistoryListResponse,
  type PromptHistoryRepository,
} from '../repositories/PromptHistoryRepository.js';

export const PROMPT_GENERATION_INPUT_MAX_CHARS = 100_000;

const REUSE_ACTIONS = ['copy', 'edit', 'save-to-library', 'use-as-project-prompt', 'enqueue'] as const;
export type PromptGenerationReuseAction = (typeof REUSE_ACTIONS)[number];

export interface PromptGenerationState {
  generation: PromptGenerationRecord;
  progress: AgentRunState | 'blocked' | 'persisting' | 'idle';
  reuseActions: PromptGenerationReuseAction[];
}

export interface PromptGenerationStartInput {
  inputText: string;
  agentType?: AgentType;
  model?: string | null;
  effort?: string | null;
  permission?: string | null;
  projectId?: string | null;
}

export interface PromptGenerationProjectContext {
  projectId: string | null;
  tigerRoot: string | null;
}

export interface PromptGenerationTerminalParams {
  id: string;
  name: string;
  cwd: string;
  command: string;
  promptPath: string;
  outputPath: string;
  markerPath: string;
}

export type PromptGenerationTerminalFactory = (params: PromptGenerationTerminalParams) => TerminalDefinition;

export interface PromptGenerationServiceOptions {
  manager: TerminalManager;
  repository?: PromptGenerationRepository;
  historyRepository?: PromptHistoryRepository;
  limitGate?: LimitGate;
  getConfig?: () => TigerConfig;
  getProjectContext?: () => PromptGenerationProjectContext;
  runtimeRoot?: () => string;
  terminalFactory?: PromptGenerationTerminalFactory;
  timing?: TigerTiming;
}

export function createDefaultPromptGenerationService(
  manager: TerminalManager,
  state: PersistedState,
  getConfig: () => TigerConfig,
  getProjectContext: () => PromptGenerationProjectContext,
): PromptGenerationService {
  return new PromptGenerationService({
    manager,
    repository: new MySqlPromptGenerationRepository(),
    historyRepository: new MySqlPromptHistoryRepository(),
    limitGate: new StateLimitGate(() => state.limits, { staleAfterMs: appConfig.limitStaleAfterMs }),
    getConfig,
    getProjectContext,
  });
}

export class PromptGenerationService extends EventEmitter {
  private readonly repository: PromptGenerationRepository;
  private readonly historyRepository: PromptHistoryRepository;
  private readonly limitGate: LimitGate;
  private readonly getConfig: () => TigerConfig;
  private readonly getProjectContext: () => PromptGenerationProjectContext;
  private readonly runtimeRoot: () => string;
  private readonly terminalFactory: PromptGenerationTerminalFactory;

  constructor(private readonly options: PromptGenerationServiceOptions) {
    super();
    this.repository = options.repository ?? new MySqlPromptGenerationRepository();
    this.historyRepository = options.historyRepository ?? new MySqlPromptHistoryRepository();
    this.limitGate = options.limitGate ?? new StateLimitGate(() => undefined);
    this.getConfig = options.getConfig ?? defaultTigerConfig;
    this.getProjectContext = options.getProjectContext ?? (() => ({ projectId: null, tigerRoot: null }));
    this.runtimeRoot =
      options.runtimeRoot ??
      (() => {
        const tigerRoot = this.getProjectContext().tigerRoot;
        return tigerRoot ? path.join(tigerRoot, 'prompt-generations') : path.join(appConfig.dataDir, 'prompt-generations');
      });
    this.terminalFactory = options.terminalFactory ?? defaultTerminalFactory;
  }

  async start(input: PromptGenerationStartInput): Promise<PromptGenerationRecord> {
    const inputText = normalizeInputText(input.inputText);
    const provider = input.agentType ?? 'claude';
    const cfg = this.getConfig();
    // Reject invalid/injectable provider overrides BEFORE any launch command is built, so an
    // arbitrary model/effort/permission string can never reach buildLaunchCommand.
    validateLaunchOverrides(provider, cfg, input);
    const model = resolveModel(provider, cfg, input.model);
    const project = this.getProjectContext();
    const generation = await this.repository.create({
      inputText,
      agentType: provider,
      model,
      projectId: input.projectId ?? project.projectId,
    });
    this.emitState(generation, 'idle');
    void this.runGeneration(generation, {
      effort: resolveEffort(provider, cfg, input.effort),
      permission: resolvePermission(provider, cfg, input.permission),
    }).catch(async (err) => {
      await this.failGeneration(generation.id, msg(err), 'failed').catch(() => {});
    });
    return generation;
  }

  async get(id: string): Promise<PromptGenerationRecord | null> {
    return this.repository.get(id);
  }

  async listHistory(filters: PromptHistoryFilters = {}): Promise<PromptHistoryListResponse> {
    return this.historyRepository.list(filters);
  }

  async recordReuseAction(
    id: string,
    action: Exclude<PromptGenerationReuseAction, 'copy' | 'edit'>,
    metadata: Record<string, unknown> = {},
  ): Promise<PromptGenerationRecord> {
    const generation = await this.requireDone(id);
    await this.historyRepository.record({
      projectId: generation.projectId,
      kind:
        action === 'save-to-library'
          ? 'saved_to_library'
          : action === 'use-as-project-prompt'
            ? 'used_as_project_prompt'
            : 'enqueue_requested',
      inputText: generation.inputText,
      outputText: generation.outputText,
      generationId: generation.id,
      metadata,
    });
    this.emitHistoryChanged();
    return generation;
  }

  toState(generation: PromptGenerationRecord, progress: PromptGenerationState['progress'] = 'idle'): PromptGenerationState {
    return {
      generation,
      progress,
      reuseActions: generation.status === 'done' ? [...REUSE_ACTIONS] : [],
    };
  }

  private async runGeneration(
    generation: PromptGenerationRecord,
    launch: { effort: string; permission: string },
  ): Promise<void> {
    const gate = await this.limitGate.check(generation.agentType);
    if (!gate.allowed) {
      await this.failGeneration(generation.id, `limit gate blocked generation: ${gate.reason}`, 'blocked');
      return;
    }

    const runtimeDir = this.runtimeRoot();
    await fs.mkdir(runtimeDir, { recursive: true });
    const runId = `prompt-generation-${generation.id}`;
    const promptPath = path.join(runtimeDir, `${generation.id}.prompt.md`);
    const outputPath = path.join(runtimeDir, `${generation.id}.output.md`);
    const markerPath = path.join(runtimeDir, `${generation.id}.done`);
    await Promise.all([
      fs.rm(outputPath, { force: true }).catch(() => {}),
      fs.rm(markerPath, { force: true }).catch(() => {}),
    ]);
    await fs.writeFile(promptPath, composeInstruction(generation.inputText, outputPath, markerPath), 'utf8');

    const cfg = this.getConfig();
    const command = buildLaunchCommand(cfg, generation.agentType, {
      model: generation.model ?? '',
      effort: launch.effort,
      permission: launch.permission,
    });
    const cwd = this.getProjectContext().tigerRoot ?? runtimeDir;
    const now = new Date().toISOString();
    const terminal = this.terminalFactory({
      id: runId,
      name: 'Prompt Generation',
      cwd,
      command,
      promptPath,
      outputPath,
      markerPath,
    });
    this.options.manager.upsertDefinition(terminal);
    let current = await this.repository.update(generation.id, {
      status: 'running',
      terminalId: runId,
      startedAt: now,
      error: null,
    });
    this.emitState(current, 'starting');

    const timing = this.options.timing ?? cfg.timing;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), totalTimeoutMs(timing));
    timeout.unref();
    try {
      const session = new AgentSession({
        manager: this.options.manager,
        termId: runId,
        label: 'prompt-generation',
        command,
        cwd,
        promptPath,
        outputPath,
        markerPath,
        timing,
        onState: (state) => this.emitState(current, state),
      });

      const result = await session.run(abort.signal);
      if (result.state !== 'completed') {
        await this.failGeneration(
          generation.id,
          result.error ?? (abort.signal.aborted ? 'prompt generation timed out' : 'agent failed before producing output'),
          'failed',
        );
        return;
      }

      this.emitState(current, 'persisting');
      const outputText = (await fs.readFile(outputPath, 'utf8')).trim();
      if (!outputText) {
        await this.failGeneration(generation.id, 'agent produced empty output', 'failed');
        return;
      }
      current = await this.repository.update(generation.id, {
        status: 'done',
        outputText,
        error: null,
        completedAt: new Date().toISOString(),
      });
      await this.historyRepository.record({
        projectId: current.projectId,
        kind: 'generated',
        inputText: current.inputText,
        outputText: current.outputText,
        generationId: current.id,
        metadata: {
          agentType: current.agentType,
          model: current.model,
          terminalId: current.terminalId,
        },
      });
      this.emitHistoryChanged();
      this.emitState(current, 'idle');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requireDone(id: string): Promise<PromptGenerationRecord> {
    const generation = await this.repository.get(id);
    if (!generation) throw httpErr(404, 'prompt generation not found');
    if (generation.status !== 'done' || !generation.outputText?.trim()) {
      throw httpErr(409, 'prompt generation is not done');
    }
    return generation;
  }

  private async failGeneration(
    id: string,
    error: string,
    progress: PromptGenerationState['progress'],
  ): Promise<PromptGenerationRecord> {
    const failed = await this.repository.update(id, {
      status: 'failed',
      error,
      completedAt: new Date().toISOString(),
    });
    this.emitState(failed, progress);
    return failed;
  }

  private emitState(generation: PromptGenerationRecord, progress: PromptGenerationState['progress']): void {
    this.emit('state', this.toState(generation, progress));
  }

  private emitHistoryChanged(): void {
    this.emit('history.changed');
  }
}

function defaultTerminalFactory(params: PromptGenerationTerminalParams): TerminalDefinition {
  const now = new Date().toISOString();
  return {
    id: params.id,
    name: params.name,
    groupId: null,
    cwd: params.cwd,
    initialCommand: params.command,
    shell: { kind: 'system-default' },
    protected: true,
    createdAt: now,
    updatedAt: now,
  };
}

function composeInstruction(inputText: string, outputPath: string, markerPath: string): string {
  return `# Prompt Generation Task

You are improving a user's rough draft into a strong, directly usable prompt.

Write the improved prompt to exactly this file:
${outputPath}

When and only when the output file has been written, create this completion marker file containing the single word "done":
${markerPath}

Rules:
- Work autonomously. Do not ask questions.
- Preserve the user's intent, constraints, domain, and language unless the draft explicitly asks for translation.
- Turn vague wording into concrete objectives, context, deliverables, constraints, and acceptance criteria.
- Keep the result concise enough to be practical, but include all details needed for a high-quality answer.
- Output only the improved prompt in the output file. Do not include commentary, analysis, markdown fences, or a preamble unless the prompt itself needs markdown.
- The output file must be non-empty.

Rough draft:
<<<DRAFT
${inputText}
DRAFT
`;
}

function normalizeInputText(inputText: string): string {
  if (typeof inputText !== 'string') throw httpErr(400, 'inputText must be a string');
  const trimmed = inputText.trim();
  if (!trimmed) throw httpErr(400, 'inputText is required');
  if (trimmed.length > PROMPT_GENERATION_INPUT_MAX_CHARS) {
    throw httpErr(413, `inputText must be ${PROMPT_GENERATION_INPUT_MAX_CHARS} characters or fewer`);
  }
  return trimmed;
}

/**
 * Validate the optional per-request model/effort/permission overrides against the provider's
 * configuration before anything is launched. Throws a 400 on an unsafe model (quotes, shell
 * metacharacters, control characters), an effort the provider does not accept, or an unknown
 * permission key. Omitted/empty overrides fall back to the provider defaults and are always valid.
 */
function validateLaunchOverrides(provider: AgentType, cfg: TigerConfig, input: PromptGenerationStartInput): void {
  if (typeof input.model === 'string') {
    const model = input.model.trim();
    if (!isLaunchSafeModel(provider, model)) {
      throw httpErr(400, `model is not a valid ${provider} model identifier`);
    }
  }
  if (typeof input.effort === 'string') {
    const effort = input.effort.trim();
    if (!effortsForProvider(provider).includes(effort)) {
      throw httpErr(400, `effort "${effort}" is not a valid ${provider} effort`);
    }
  }
  if (typeof input.permission === 'string') {
    const permission = input.permission.trim();
    if (permission !== '' && !Object.prototype.hasOwnProperty.call(cfg.cli[provider].permissionModes, permission)) {
      throw httpErr(400, `permission "${permission}" is not a known ${provider} permission mode`);
    }
  }
}

function resolveModel(provider: AgentType, cfg: TigerConfig, requested: string | null | undefined): string {
  if (typeof requested === 'string') return requested.trim();
  const d = cfg.defaults;
  return provider === 'claude' ? d.claudeModel : provider === 'codex' ? d.codexModel : d.antigravityModel;
}

function resolveEffort(provider: AgentType, cfg: TigerConfig, requested: string | null | undefined): string {
  if (typeof requested === 'string') return requested.trim();
  const d = cfg.defaults;
  return provider === 'claude' ? d.claudeEffort : provider === 'codex' ? d.codexEffort : d.antigravityEffort;
}

function resolvePermission(provider: AgentType, cfg: TigerConfig, requested: string | null | undefined): string {
  if (typeof requested === 'string') return requested.trim();
  const d = cfg.defaults;
  return provider === 'claude' ? d.claudePermission : provider === 'codex' ? d.codexPermission : d.antigravityPermission;
}

function totalTimeoutMs(timing: TigerTiming): number {
  return timing.readyMaxWaitMs + timing.settleMaxWaitMs + timing.agentTimeoutMs + Math.max(10_000, timing.markerPollMs * 4);
}

function httpErr(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
