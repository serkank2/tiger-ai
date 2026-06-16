import type {
  AppSettings,
  Group,
  PromptFile,
  PromptSummary,
  TerminalDto,
  TerminalInput,
  TerminalStatus,
  TigerConfig,
  TigerStageId,
  TigerStageRunConfig,
  TigerState,
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

/** Typed REST client for the Kaplan backend. */
export function useApi() {
  const base = useRuntimeConfig().public.apiBase as string;
  const req = <T>(path: string, opts?: Parameters<typeof $fetch>[1]) => $fetch<T>(`${base}${path}`, opts);

  return {
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

    // --- Tiger orchestrator ---
    getTigerState: () => req<TigerState>('/api/tiger/state'),
    getTigerConfig: () => req<TigerConfig>('/api/tiger/config'),
    updateTigerConfig: (body: Partial<TigerConfig>) =>
      req<TigerConfig>('/api/tiger/config', { method: 'PUT', body }),
    initTigerWorkspace: (path: string, projectPrompt: string) =>
      req<TigerState>('/api/tiger/workspace', { method: 'POST', body: { path, projectPrompt } }),
    runTigerStage: (stage: TigerStageId, cfg: TigerStageRunConfig) =>
      req<TigerState>(`/api/tiger/stages/${stage}/run`, { method: 'POST', body: cfg }),
    retryTigerStage: (stage: TigerStageId) =>
      req<TigerState>(`/api/tiger/stages/${stage}/retry`, { method: 'POST' }),
    stopTiger: () => req<TigerState>('/api/tiger/stop', { method: 'POST' }),
    readTigerFile: (path: string) =>
      req<{ path: string; content: string }>(`/api/tiger/file?path=${encodeURIComponent(path)}`),
  };
}
