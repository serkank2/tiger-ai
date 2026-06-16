import type { AppSettings, Group, TerminalDto, TerminalInput, TerminalStatus } from '~/types';

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
  };
}
