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
  QueueBulkAction,
  QueueBulkResponse,
  QueueEnqueueInput,
  QueueHistoryQuery,
  QueueHistoryResponse,
  QueueJob,
  QueueRule,
  QueueState,
  TerminalDto,
  TerminalInput,
  TerminalStatus,
  CueEngineStatus,
  CueSubscriptionStatus,
  CueSubscriptionInput,
  RunSnapshot,
  RunEventDto,
  RunCreateConfigInput,
  RunChanges,
  RunIndexEntry,
  ProvidersConfig,
  ProvidersConfigPatch,
} from '~/types';

/**
 * Read the optional shared-token auth credential. It is persisted to localStorage
 * by the settings store under this key; we read it directly here (not via the
 * store) so this composable carries no store/auto-import dependency.
 */
const AUTH_TOKEN_KEY = 'kaplan.authToken';
function getStoredAuthToken(): string {
  if (typeof localStorage === 'undefined') return '';
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

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

/** Status codes from the optional shared-token auth that we surface to the user. */
function surfaceAuthError(status: number | undefined): void {
  if (status !== 401 && status !== 429) return;
  // Lazily resolve notices so useApi() stays usable without an active Pinia
  // instance (e.g. in unit tests that only stub $fetch / useRuntimeConfig).
  try {
    const notices = useNoticesStore();
    notices.push(
      status === 401
        ? 'Unauthorized — set or check your auth token in Settings.'
        : 'Rate limited by the server — slow down or check your auth token in Settings.',
      'error',
    );
  } catch {
    /* no Pinia available — skip the toast */
  }
}

/** Typed REST client for the Kaplan backend. */
export function useApi() {
  const base = useRuntimeConfig().public.apiBase as string;
  const req = <T>(path: string, opts?: Parameters<typeof $fetch>[1]) => {
    // Attach the shared-token Authorization header only when a token is set, so the
    // no-token path stays byte-identical (the second arg remains `undefined`).
    const token = getStoredAuthToken();
    const withAuth = token
      ? {
          ...(opts ?? {}),
          headers: {
            ...((opts as { headers?: Record<string, string> })?.headers ?? {}),
            Authorization: `Bearer ${token}`,
          },
        }
      : opts;
    return ($fetch<T>(`${base}${path}`, withAuth) as Promise<T>).catch((e: unknown) => {
      surfaceAuthError(
        (e as { status?: number; statusCode?: number })?.status ?? (e as { statusCode?: number })?.statusCode,
      );
      throw e;
    });
  };

  return {
    getHealth: () => req<HealthStatus>('/api/health'),

    listTerminals: () => req<TerminalDto[]>('/api/terminals'),
    createTerminal: (body: TerminalInput) => req<TerminalDto>('/api/terminals', { method: 'POST', body }),
    updateTerminal: (id: string, body: Partial<TerminalInput>) =>
      req<TerminalDto>(`/api/terminals/${id}`, { method: 'PUT', body }),
    deleteTerminal: (id: string) => req<void>(`/api/terminals/${id}`, { method: 'DELETE' }),
    startTerminal: (id: string, size?: Size) =>
      req<TerminalStatus>(`/api/terminals/${id}/start`, { method: 'POST', body: size ?? {} }),
    stopTerminal: (id: string) => req<TerminalStatus>(`/api/terminals/${id}/stop`, { method: 'POST' }),
    restartTerminal: (id: string, size?: Size) =>
      req<TerminalStatus>(`/api/terminals/${id}/restart`, { method: 'POST', body: size ?? {} }),

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
    deletePrompt: (path: string) =>
      req<void>(`/api/prompts/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
    renamePrompt: (fromPath: string, toPath: string, overwrite = false) =>
      req<PromptFile>('/api/prompts/rename', { method: 'POST', body: { fromPath, toPath, overwrite } }),
    listPromptHistory: (filters: PromptHistoryFilters = {}) =>
      req<PromptHistoryListResponse>(`/api/prompts/history${queryString(filters as Record<string, unknown>)}`),

    getLimits: () => req<LimitStatus>('/api/limits'),
    refreshLimits: () => req<LimitStatus>('/api/limits/refresh', { method: 'POST' }),
    listLimitRules: () => req<LimitRule[]>('/api/limits/rules'),
    createLimitRule: (body: LimitRuleInput) => req<LimitStatus>('/api/limits/rules', { method: 'POST', body }),
    updateLimitRule: (id: string, body: LimitRuleInput) =>
      req<LimitStatus>(`/api/limits/rules/${encodeURIComponent(id)}`, { method: 'PUT', body }),
    deleteLimitRule: (id: string) =>
      req<LimitStatus>(`/api/limits/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    // --- Autonomous queue ---
    getQueueState: () => req<QueueState>('/api/queue/state'),
    getQueueHistory: (params: QueueHistoryQuery = {}) =>
      req<QueueHistoryResponse>(`/api/queue/history${queryString(params as Record<string, unknown>)}`),
    enqueueQueueJob: (body: QueueEnqueueInput) => req<QueueJob>('/api/queue/enqueue', { method: 'POST', body }),
    enqueueQueue: (body: QueueEnqueueInput) => req<QueueJob>('/api/queue/enqueue', { method: 'POST', body }),
    reorderQueue: (ids: string[]) => req<QueueState>('/api/queue/reorder', { method: 'POST', body: { ids } }),
    bulkQueue: (action: QueueBulkAction, ids: string[]) =>
      req<QueueBulkResponse>('/api/queue/bulk', { method: 'POST', body: { action, ids } }),
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

    // --- v2 runs (WorkGraph engine) ---
    createRun: (body: { workspace: string; goal: string; config?: RunCreateConfigInput }) =>
      req<{ run: RunSnapshot }>('/api/runs', { method: 'POST', body }),
    getCurrentRun: () => req<{ run: RunSnapshot | null }>('/api/runs/current'),
    startRun: () => req<{ run: RunSnapshot }>('/api/runs/current/start', { method: 'POST' }),
    stopRun: (reason?: string) =>
      req<{ run: RunSnapshot }>('/api/runs/current/stop', { method: 'POST', body: reason ? { reason } : {} }),
    steerRun: (body: string, interrupt = false) =>
      req<{ run: RunSnapshot }>('/api/runs/current/steer', { method: 'POST', body: { body, interrupt } }),
    interactiveInput: (agentId: string, data: string) =>
      req<{ ok: boolean }>('/api/runs/current/input', { method: 'POST', body: { agentId, data } }),
    interactiveComplete: (agentId: string) =>
      req<{ ok: boolean }>('/api/runs/current/complete', { method: 'POST', body: { agentId } }),
    listRunEvents: (afterSeq = 0) => req<{ events: RunEventDto[] }>(`/api/runs/current/events?afterSeq=${afterSeq}`),
    getRunChanges: () => req<{ changes: RunChanges }>('/api/runs/current/changes'),
    listRuns: () => req<{ runs: RunIndexEntry[] }>('/api/runs'),
    getRunById: (runId: string) => req<{ run: RunSnapshot }>(`/api/runs/${encodeURIComponent(runId)}`),
    getProvidersConfig: () => req<{ config: ProvidersConfig }>('/api/providers/config'),
    updateProvidersConfig: (body: ProvidersConfigPatch) =>
      req<{ config: ProvidersConfig }>('/api/providers/config', { method: 'PUT', body }),

    // --- Cue (event-driven orchestration engine) ---
    getCueStatus: () => req<CueEngineStatus>('/api/cue/status'),
    listCueSubscriptions: () => req<{ subscriptions: CueSubscriptionStatus[] }>('/api/cue/subscriptions'),
    reloadCue: () => req<CueEngineStatus>('/api/cue/reload', { method: 'POST' }),
    triggerCue: (id: string, vars?: Record<string, string>) =>
      req<CueSubscriptionStatus>(`/api/cue/trigger/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: vars ? { vars } : {},
      }),
    getCueSubscription: (id: string) =>
      req<{ subscription: CueSubscriptionInput }>(`/api/cue/subscriptions/${encodeURIComponent(id)}`),
    createCueSubscription: (sub: CueSubscriptionInput) =>
      req<{ subscription: CueSubscriptionInput; status: CueEngineStatus }>('/api/cue/subscriptions', {
        method: 'POST',
        body: sub,
      }),
    updateCueSubscription: (id: string, sub: CueSubscriptionInput) =>
      req<{ subscription: CueSubscriptionInput; status: CueEngineStatus }>(
        `/api/cue/subscriptions/${encodeURIComponent(id)}`,
        { method: 'PUT', body: sub },
      ),
    deleteCueSubscription: (id: string) =>
      req<CueEngineStatus>(`/api/cue/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
}
