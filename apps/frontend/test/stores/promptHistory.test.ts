import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { usePromptHistoryStore } from '~/stores/promptHistory';
import type { PromptHistoryEvent } from '~/types';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (msg: unknown) => void>();
  return {
    listeners,
    api: {
      listPromptHistory: vi.fn(),
    },
    notices: {
      push: vi.fn(),
    },
    onServerEvent: vi.fn(),
  };
});

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }));
vi.mock('~/stores/notices', () => ({ useNoticesStore: () => mocks.notices }));
vi.mock('~/composables/useSocket', () => ({
  useSocket: () => ({
    onServerEvent: mocks.onServerEvent,
  }),
}));

function historyEvent(id: string, overrides: Partial<PromptHistoryEvent> = {}): PromptHistoryEvent {
  return {
    id,
    projectId: 'project-a',
    kind: 'generated',
    inputText: 'rough deploy note',
    outputText: 'Polished deploy prompt',
    generationId: 'generation-a',
    metadata: { terminalId: 'prompt-generation-generation-a' },
    createdAt: '2026-06-18T07:00:00.000Z',
    status: 'done',
    agentType: 'codex',
    model: 'gpt-5',
    error: null,
    ...overrides,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('usePromptHistoryStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.onServerEvent.mockImplementation((type: string, cb: (msg: unknown) => void) => {
      mocks.listeners.set(type, cb);
      return () => mocks.listeners.delete(type);
    });
  });

  it('fetches history rows and silently refreshes after the history.changed socket event', async () => {
    mocks.api.listPromptHistory
      .mockResolvedValueOnce({ items: [historyEvent('hist-1')], total: 1 })
      .mockResolvedValueOnce({
        items: [
          historyEvent('hist-2', {
            kind: 'enqueue_requested',
            inputText: 'queue this refactor',
            outputText: null,
            generationId: null,
            metadata: { status: 'queued' },
            status: null,
          }),
          historyEvent('hist-1'),
        ],
        total: 2,
      });

    const store = usePromptHistoryStore();
    await store.fetchAll({ text: 'deploy', limit: 25 });

    expect(mocks.api.listPromptHistory).toHaveBeenCalledWith({ text: 'deploy', limit: 25 });
    expect(store.loaded).toBe(true);
    expect(store.items.map((item) => item.id)).toEqual(['hist-1']);
    expect(store.total).toBe(1);

    const unbind = store.bindSocket();
    expect(mocks.onServerEvent).toHaveBeenCalledWith('history.changed', expect.any(Function));
    mocks.listeners.get('history.changed')?.({ type: 'history.changed' });
    await flushPromises();

    expect(mocks.api.listPromptHistory).toHaveBeenLastCalledWith({});
    expect(store.items.map((item) => item.id)).toEqual(['hist-2', 'hist-1']);
    expect(store.total).toBe(2);
    expect(store.lastChangedAt).toEqual(expect.any(String));

    unbind();
    expect(mocks.listeners.has('history.changed')).toBe(false);
  });
});
