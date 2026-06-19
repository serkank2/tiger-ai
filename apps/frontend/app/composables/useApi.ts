import type {
  AppSettings,
  Group,
  HealthStatus,
  LimitRule,
  LimitRuleInput,
  LimitStatus,
  PromptFile,
  PromptGenerationReuseAction,
  PromptGenerationState,
  PromptGenerationStartInput,
  PromptHistoryFilters,
  PromptHistoryListResponse,
  PromptSummary,
  QueueEnqueueInput,
  QueueJob,
  QueueRule,
  QueueState,
  CreateTeamRunResponse,
  TeamChanges,
  SteerResponse,
  TeamArtifact,
  TeamMessageHistoryParams,
  TeamMessagePage,
  TeamRunStateResponse,
  TeamRunStartInput,
  TeamSteeringInput,
  TeamTemplate,
  TeamTemplatePayload,
  TeamTemplatesResponse,
  TerminalDto,
  TerminalInput,
  TerminalStatus,
  TigerConfig,
  TigerProjectInfo,
  TigerRunTemplate,
  TigerRunTemplatePayload,
  TigerStageId,
  TigerStageRunConfig,
  TigerState,
  TigerUsage,
} from '~/types';

interface Size {
  cols?: number;
  rows?: number;
}
interface ValidateResult {
  path: string;
  exists: boolean;
  isDirectory: boolean;
}
interface ListResult {
  path: string;
  parent: string;
  directories: { name: string; path: string }[];
}

function queryString(params: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const out = query.toString();
  return out ? `?${out}` : '';
}

/** Typed REST client for the Kaplan backend. */
export function useApi() {
  const base = useRuntimeConfig().public.apiBase as string;
  const req = <T>(path: string, opts?: Parameters<typeof $fetch>[1]) => $fetch<T>(`${base}${path}`, opts);

  return {
    getHealth: () => req<HealthStatus>('/api/health'),

    listTerminals: () => req<TerminalDto[]>('/api/terminals'),
    createTerminal: (body: TerminalInput) => req<TerminalDto>('/api/terminals', { method: 'POST', body }),
    updateTerminal: (id: string, body: Partial<TerminalInput>) =>
      req<TerminalDto>(`/api/terminals/${id}`, { method: 'PUT', body }),
    deleteTerminal: (id: string) => req<void>(`/api/terminals/${id}`, { method: 'DELETE' }),
    startTerminal: (id: string, size?: Size) => req<TerminalStatus>(`/api/terminals/${id}/start`, { method: 'POST', body: size ?? {} }),
    stopTerminal: (id: string) => req<TerminalStatus>(`/api/terminals/${id}/stop`, { method: 'POST' }),
    restartTerminal: (id: string, size?: Size) => req<TerminalStatus>(`/api/terminals/${id}/restart`, { method: 'POST', body: size ?? {} }),

    listGroups: () => req<Group[]>('/api/groups'),
    createGroup: (body: { name: string; color?: string }) => req<Group>('/api/groups', { method: 'POST', body }),
    updateGroup: (id: string, body: { name?: string; color?: string }) =>
      req<Group>(`/api/groups/${id}`, { method: 'PUT', body }),
    deleteGroup: (id: string) => req<void>(`/api/groups/${id}`, { method: 'DELETE' }),

    getSettings: () => req<AppSettings>('/api/settings'),
    updateSettings: (body: Partial<AppSettings>) => req<AppSettings>('/api/settings', { method: 'PUT', body }),

    validatePath: (p: string) => req<ValidateResult>(`/api/fs/validate?path=${encodeURIComponent(p)}`),
    listDir: (p?: string) => req<ListResult>(`/api/fs/list${p ? `?path=${encodeURIComponent(p)}` : ''}`),
    getHome: () => req<{ home: string; sep: string }>('/api/fs/home'),

    listPrompts: () => req<{ items: PromptSummary[] }>('/api/prompts'),
    readPrompt: (path: string) => req<PromptFile>(`/api/prompts/file?path=${encodeURIComponent(path)}`),
    createPrompt: (path: string, content: string, overwrite = false) =>
      req<PromptFile>('/api/prompts', { method: 'POST', body: { path, content, overwrite } }),
    updatePrompt: (path: string, content: string, expectedVersion?: string) =>
      req<PromptFile>('/api/prompts/file', { method: 'PUT', body: { path, content, expectedVersion } }),
    deletePrompt: (path: string) => req<void>(`/api/prompts/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
    renamePrompt: (fromPath: string, toPath: string, overwrite = false) =>
      req<PromptFile>('/api/prompts/rename', { method: 'POST', body: { fromPath, toPath, overwrite } }),
    listPromptHistory: (filters: PromptHistoryFilters = {}) =>
      req<PromptHistoryListResponse>(`/api/prompts/history${queryString(filters as Record<string, unknown>)}`),

    // --- Tiger orchestrator ---
    getTigerState: () => req<TigerState>('/api/tiger/state'),
    getTigerConfig: () => req<TigerConfig>('/api/tiger/config'),
    listTigerProjects: () => req<TigerProjectInfo[]>('/api/tiger/projects'),
    openTigerProject: (path: string) =>
      req<TigerState>('/api/tiger/projects/open', { method: 'POST', body: { path } }),
    closeTigerProject: () => req<TigerState>('/api/tiger/projects/close', { method: 'POST' }),
    forgetTigerProject: (path: string) =>
      req<TigerProjectInfo[]>('/api/tiger/projects', { method: 'DELETE', body: { path } }),
    updateTigerConfig: (body: Partial<TigerConfig>) =>
      req<TigerConfig>('/api/tiger/config', { method: 'PUT', body }),
    initTigerWorkspace: (path: string, projectPrompt: string) =>
      req<TigerState>('/api/tiger/workspace', { method: 'POST', body: { path, projectPrompt } }),
    replaceTigerProjectPrompt: (projectPrompt: string) =>
      req<TigerState>('/api/tiger/project-prompt', { method: 'PUT', body: { projectPrompt } }),
    runTigerStage: (stage: TigerStageId, cfg: TigerStageRunConfig, auto = false) =>
      req<TigerState>(`/api/tiger/stages/${stage}/run`, { method: 'POST', body: { ...cfg, auto } }),
    runAllTiger: (configs: Partial<Record<TigerStageId, TigerStageRunConfig>>, fromStage?: TigerStageId) =>
      req<TigerState>('/api/tiger/run-all', { method: 'POST', body: { configs, fromStage } }),
    listTigerTemplates: () => req<TigerRunTemplate[]>('/api/tiger/templates'),
    createTigerTemplate: (t: TigerRunTemplatePayload) =>
      req<TigerRunTemplate[]>('/api/tiger/templates', { method: 'POST', body: t }),
    updateTigerTemplate: (id: string, t: Partial<TigerRunTemplatePayload>) =>
      req<TigerRunTemplate>(`/api/tiger/templates/${encodeURIComponent(id)}`, { method: 'PUT', body: t }),
    duplicateTigerTemplate: (id: string, t?: Partial<TigerRunTemplatePayload>) =>
      req<TigerRunTemplate>(`/api/tiger/templates/${encodeURIComponent(id)}/duplicate`, {
        method: 'POST',
        body: t ?? {},
      }),
    applyTigerTemplate: (id: string) =>
      req<TigerRunTemplate>(`/api/tiger/templates/${encodeURIComponent(id)}/apply`, { method: 'POST' }),
    archiveTigerTemplate: (id: string) =>
      req<TigerRunTemplate[]>(`/api/tiger/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    saveTigerTemplate: (t: TigerRunTemplatePayload) =>
      req<TigerRunTemplate[]>('/api/tiger/templates', { method: 'POST', body: t }),
    deleteTigerTemplate: (name: string) =>
      req<TigerRunTemplate[]>(`/api/tiger/templates?name=${encodeURIComponent(name)}`, { method: 'DELETE' }),
    retryTigerStage: (stage: TigerStageId) =>
      req<TigerState>(`/api/tiger/stages/${stage}/retry`, { method: 'POST' }),
    continueTigerStage: (stage: TigerStageId) =>
      req<TigerState>(`/api/tiger/stages/${stage}/continue`, { method: 'POST' }),
    routeTigerCorrection: (target: 'executing-plan' | 'task-review') =>
      req<TigerState>('/api/tiger/route', { method: 'POST', body: { target } }),
    stopTiger: () => req<TigerState>('/api/tiger/stop', { method: 'POST' }),
    readTigerFile: (path: string) =>
      req<{ path: string; content: string }>(`/api/tiger/file?path=${encodeURIComponent(path)}`),
    getTigerUsage: () => req<TigerUsage>('/api/tiger/usage'),
    getLimits: () => req<LimitStatus>('/api/limits'),
    refreshLimits: () => req<LimitStatus>('/api/limits/refresh', { method: 'POST' }),
    listLimitRules: () => req<LimitRule[]>('/api/limits/rules'),
    createLimitRule: (body: LimitRuleInput) => req<LimitStatus>('/api/limits/rules', { method: 'POST', body }),
    updateLimitRule: (id: string, body: LimitRuleInput) =>
      req<LimitStatus>(`/api/limits/rules/${encodeURIComponent(id)}`, { method: 'PUT', body }),
    deleteLimitRule: (id: string) =>
      req<LimitStatus>(`/api/limits/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    // --- Team orchestrator ---
    listTeamTemplates: () => req<TeamTemplatesResponse>('/api/team/templates'),
    listTeamProjects: () => req<{ projects: string[]; lastWorkspace: string | null }>('/api/team/projects'),
    createTeamTemplate: (body: TeamTemplatePayload) =>
      req<{ template: TeamTemplate }>('/api/team/templates', { method: 'POST', body }),
    updateTeamTemplate: (id: string, body: TeamTemplatePayload) =>
      req<{ template: TeamTemplate }>(`/api/team/templates/${encodeURIComponent(id)}`, { method: 'PUT', body }),
    duplicateTeamTemplate: (id: string, body: { name?: string } = {}) =>
      req<{ template: TeamTemplate }>(`/api/team/templates/${encodeURIComponent(id)}/duplicate`, { method: 'POST', body }),
    deleteTeamTemplate: (id: string) =>
      req<{ ok: boolean }>(`/api/team/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    getTeamState: () => req<TeamRunStateResponse>('/api/team/state'),
    startTeamRun: (body: TeamRunStartInput) =>
      req<TeamRunStateResponse | CreateTeamRunResponse>('/api/team/runs', { method: 'POST', body }),
    stopTeamRun: (id: string) =>
      req<TeamRunStateResponse>(`/api/team/runs/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
    pauseTeamRun: (id: string) =>
      req<TeamRunStateResponse>(`/api/team/runs/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
    resumeTeamRun: (id: string) =>
      req<TeamRunStateResponse>(`/api/team/runs/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
    closeTeamRun: (id: string) =>
      req<TeamRunStateResponse>(`/api/team/runs/${encodeURIComponent(id)}/close`, { method: 'POST' }),
    steerTeamRun: (id: string, body: TeamSteeringInput) =>
      req<TeamRunStateResponse | SteerResponse>(`/api/team/runs/${encodeURIComponent(id)}/steer`, { method: 'POST', body }),
    listTeamMessages: (runId: string, params: TeamMessageHistoryParams = {}) =>
      req<TeamMessagePage>(`/api/team/runs/${encodeURIComponent(runId)}/messages${queryString(params as Record<string, unknown>)}`),
    getTeamMessageHistory: (runId: string, params: TeamMessageHistoryParams = {}) =>
      req<TeamMessagePage>(`/api/team/runs/${encodeURIComponent(runId)}/messages${queryString(params as Record<string, unknown>)}`),
    listTeamArtifacts: (runId: string) =>
      req<TeamArtifact[]>(`/api/team/runs/${encodeURIComponent(runId)}/artifacts`),
    getTeamArtifacts: (runId: string) =>
      req<TeamArtifact[]>(`/api/team/runs/${encodeURIComponent(runId)}/artifacts`),
    readTeamArtifact: (runId: string, path: string) =>
      req<{ path: string; content: string; artifact?: TeamArtifact }>(
        `/api/team/runs/${encodeURIComponent(runId)}/artifacts/file?path=${encodeURIComponent(path)}`,
      ),
    getTeamChanges: (runId: string) =>
      req<TeamChanges>(`/api/team/runs/${encodeURIComponent(runId)}/changes`),
    submitTeamSteering: (id: string, body: TeamSteeringInput) =>
      req<TeamRunStateResponse | SteerResponse>(`/api/team/runs/${encodeURIComponent(id)}/steer`, { method: 'POST', body }),

    // --- Autonomous queue ---
    getQueueState: () => req<QueueState>('/api/queue/state'),
    enqueueQueueJob: (body: QueueEnqueueInput) =>
      req<QueueJob>('/api/queue/enqueue', { method: 'POST', body }),
    enqueueQueue: (body: QueueEnqueueInput) => req<QueueJob>('/api/queue/enqueue', { method: 'POST', body }),
    reorderQueue: (ids: string[]) => req<QueueState>('/api/queue/reorder', { method: 'POST', body: { ids } }),
    pauseQueueJob: (id: string) => req<QueueJob>(`/api/queue/${id}/pause`, { method: 'POST' }),
    resumeQueueJob: (id: string) => req<QueueJob>(`/api/queue/${id}/resume`, { method: 'POST' }),
    cancelQueueJob: (id: string) => req<QueueJob>(`/api/queue/${id}/cancel`, { method: 'POST' }),
    retryQueueJob: (id: string) => req<QueueJob>(`/api/queue/${id}/retry`, { method: 'POST' }),
    listQueueRules: () => req<QueueRule[]>('/api/queue/rules'),
    createQueueRule: (body: Partial<QueueRule>) => req<QueueRule>('/api/queue/rules', { method: 'POST', body }),
    updateQueueRule: (id: string, body: Partial<QueueRule>) =>
      req<QueueRule>(`/api/queue/rules/${id}`, { method: 'PUT', body }),
    deleteQueueRule: (id: string) => req<void>(`/api/queue/rules/${id}`, { method: 'DELETE' }),

    // --- Prompt generation (screen internals delivered by a later task) ---
    startPromptGeneration: (body: PromptGenerationStartInput) =>
      req<PromptGenerationState>('/api/prompts/generate', { method: 'POST', body }),
    getPromptGeneration: (id: string) => req<PromptGenerationState>(`/api/prompts/generate/${id}`),
    reusePromptGeneration: (id: string, action: PromptGenerationReuseAction, body: Record<string, unknown> = {}) =>
      req<Record<string, unknown>>(`/api/prompts/generate/${id}/reuse`, { method: 'POST', body: { ...body, action } }),
  };
}
