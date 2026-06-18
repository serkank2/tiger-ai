import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick, reactive } from 'vue';
import { useTeamStore } from '~/stores/team';
import type { RoleSnapshot, RoleTemplate, TeamArtifact, TeamMessage, TeamMessagePage, TeamRunState, TeamTemplate } from '~/types';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (msg: unknown) => void>();
  return {
    listeners,
    conn: { status: 'disconnected' },
    api: {
      listTeamTemplates: vi.fn(),
      getTeamState: vi.fn(),
      startTeamRun: vi.fn(),
      stopTeamRun: vi.fn(),
      pauseTeamRun: vi.fn(),
      resumeTeamRun: vi.fn(),
      steerTeamRun: vi.fn(),
      listTeamMessages: vi.fn(),
      listTeamArtifacts: vi.fn(),
    },
    notices: {
      push: vi.fn(),
    },
    onServerEvent: vi.fn(),
  };
});

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }));
vi.mock('~/stores/notices', () => ({ useNoticesStore: () => mocks.notices }));
vi.mock('~/stores/connection', () => ({ useConnectionStore: () => mocks.conn }));
vi.mock('~/composables/useSocket', () => ({
  useSocket: () => ({
    onServerEvent: mocks.onServerEvent,
  }),
}));

function flushPromises(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

const roleTemplate: RoleTemplate = {
  id: 'developer',
  name: 'Developer',
  description: 'Writes code',
  persona: 'You are a developer.',
  agent: {
    tool: 'codex',
    model: 'gpt-5',
    effort: 'medium',
    permission: 'default',
  },
  canWriteCode: true,
  requiredForSignoff: true,
};

const role: RoleSnapshot = {
  id: 'developer',
  name: 'Developer',
  tool: 'codex',
  status: 'working',
  canWriteCode: true,
  requiredForSignoff: true,
  signedOff: false,
};

function template(overrides: Partial<TeamTemplate> = {}): TeamTemplate {
  return {
    id: 'template-1',
    name: 'Delivery team',
    description: 'A delivery team',
    builtin: true,
    roles: [roleTemplate],
    ...overrides,
  };
}

function state(overrides: Partial<TeamRunState> = {}): TeamRunState {
  return {
    id: 'run-1',
    name: 'Delivery team run',
    goal: 'Build the feature',
    status: 'running',
    roles: [role],
    doneGate: {
      satisfied: false,
      requiredRoleIds: ['developer'],
      signedOffRoleIds: [],
      pendingRoleIds: ['developer'],
    },
    messageCount: 0,
    recentMessages: [],
    pendingSteering: [],
    updatedAt: '2026-06-18T08:10:00.000Z',
    ...overrides,
  };
}

function message(id: string, overrides: Partial<TeamMessage> = {}): TeamMessage {
  return {
    id,
    runId: 'run-1',
    turnId: 'turn-1',
    seq: Number(id.replace(/\D/g, '')) || 1,
    from: 'developer',
    kind: 'chat',
    body: `Message ${id}`,
    createdAt: `2026-06-18T08:0${Number(id.replace(/\D/g, '')) || 1}:00.000Z`,
    ...overrides,
  };
}

function page(items: TeamMessage[], nextCursor: string | null = null): TeamMessagePage {
  return { items, nextCursor, hasMore: Boolean(nextCursor) };
}

function artifact(overrides: Partial<TeamArtifact> = {}): TeamArtifact {
  return {
    id: 'artifact-1',
    runId: 'run-1',
    path: 'reports/plan.md',
    name: 'plan.md',
    kind: 'markdown',
    createdAt: '2026-06-18T08:12:00.000Z',
    ...overrides,
  };
}

describe('useTeamStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.conn = reactive({ status: 'disconnected' }) as typeof mocks.conn;
    mocks.onServerEvent.mockImplementation((type: string, cb: (msg: unknown) => void) => {
      mocks.listeners.set(type, cb);
      return () => mocks.listeners.delete(type);
    });
  });

  it('hydrates templates, compact state, transcript, and artifacts from REST', async () => {
    mocks.api.listTeamTemplates.mockResolvedValue({ teams: [template()], roles: [roleTemplate] });
    mocks.api.getTeamState.mockResolvedValue({ state: state() });
    mocks.api.listTeamMessages.mockResolvedValue(page([message('m1')], 'cursor-2'));
    mocks.api.listTeamArtifacts.mockResolvedValue([artifact()]);

    const store = useTeamStore();
    await store.hydrate();

    expect(store.loaded).toBe(true);
    expect(store.templates.map((item) => item.id)).toEqual(['template-1']);
    expect(store.roleTemplates.map((item) => item.id)).toEqual(['developer']);
    expect(store.activeRun?.id).toBe('run-1');
    expect(store.messages.map((item) => item.id)).toEqual(['m1']);
    expect(store.nextCursor).toBe('cursor-2');
    expect(store.artifacts.map((item) => item.path)).toEqual(['reports/plan.md']);
    expect(mocks.api.listTeamMessages).toHaveBeenCalledWith('run-1', { limit: 50 });
  });

  it('replaces team.state snapshots and appends each message id only once', () => {
    const store = useTeamStore();
    store.applyState(state());

    expect(store.loaded).toBe(true);
    expect(store.activeRun?.status).toBe('running');

    store.applyState(state({ status: 'paused' }));
    store.appendMessage(message('m2', { seq: 2 }));
    store.appendMessage(message('m1', { seq: 1 }));
    store.appendMessage(message('m1', { seq: 1, body: 'Replayed message' }));

    expect(store.activeRun?.status).toBe('paused');
    expect(store.messages.map((item) => item.id)).toEqual(['m1', 'm2']);
    expect(store.messages).toHaveLength(2);
  });

  it('binds team socket events and dedupes replayed transcript on reconnect hydration', async () => {
    const store = useTeamStore();
    store.applyState(state());
    store.appendMessage(message('m1'));

    const unbind = store.bindSocket();
    expect(mocks.onServerEvent).toHaveBeenCalledWith('team.state', expect.any(Function));
    expect(mocks.onServerEvent).toHaveBeenCalledWith('team.message', expect.any(Function));

    mocks.listeners.get('team.state')?.({ type: 'team.state', state: state({ status: 'paused' }) });
    mocks.listeners.get('team.message')?.({ type: 'team.message', message: message('m2', { seq: 2 }) });

    expect(store.activeRun?.status).toBe('paused');
    expect(store.messages.map((item) => item.id)).toEqual(['m1', 'm2']);

    mocks.api.listTeamTemplates.mockResolvedValue({ teams: [template()], roles: [roleTemplate] });
    mocks.api.getTeamState.mockResolvedValue({ state: state() });
    mocks.api.listTeamMessages.mockResolvedValue(page([message('m1'), message('m2', { seq: 2 }), message('m3', { seq: 3 })]));
    mocks.api.listTeamArtifacts.mockResolvedValue([]);

    mocks.conn.status = 'connected';
    await nextTick();
    await flushPromises();

    expect(store.messages.map((item) => item.id)).toEqual(['m1', 'm2', 'm3']);

    unbind();
    expect(mocks.listeners.has('team.state')).toBe(false);
    expect(mocks.listeners.has('team.message')).toBe(false);
  });

  it('calls run controls and steering through the API', async () => {
    const store = useTeamStore();
    store.applyState(state());
    mocks.api.startTeamRun.mockResolvedValue({ state: state() });
    mocks.api.pauseTeamRun.mockResolvedValue({ state: state({ status: 'paused' }) });
    mocks.api.resumeTeamRun.mockResolvedValue({ state: state() });
    mocks.api.steerTeamRun.mockResolvedValue({ state: state() });
    mocks.api.stopTeamRun.mockResolvedValue({ state: state({ status: 'stopped' }) });
    mocks.api.listTeamMessages.mockResolvedValue(page([]));
    mocks.api.listTeamArtifacts.mockResolvedValue([]);

    await store.start({ templateId: 'template-1', goal: 'Build the feature' });
    await store.pause();
    await store.resume('run-1');
    await store.steer('Focus on test coverage');
    await store.stop('run-1');

    expect(mocks.api.startTeamRun).toHaveBeenCalledWith({ templateId: 'template-1', goal: 'Build the feature' });
    expect(mocks.api.pauseTeamRun).toHaveBeenCalledWith('run-1');
    expect(mocks.api.resumeTeamRun).toHaveBeenCalledWith('run-1');
    expect(mocks.api.steerTeamRun).toHaveBeenCalledWith('run-1', { body: 'Focus on test coverage' });
    expect(mocks.api.stopTeamRun).toHaveBeenCalledWith('run-1');
  });

  it('surfaces action failures through actionError and notices', async () => {
    const store = useTeamStore();
    store.applyState(state());
    const error = { data: { error: { message: 'run cannot be paused' } } };
    mocks.api.pauseTeamRun.mockRejectedValue(error);

    await expect(store.pause('run-1')).rejects.toBe(error);

    expect(store.actionError).toBe('run cannot be paused');
    expect(mocks.notices.push).toHaveBeenCalledWith('Team pause failed: run cannot be paused', 'error');
  });
});
