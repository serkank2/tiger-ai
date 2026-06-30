import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { TigerRunTemplate } from '~/types';

const mocks = vi.hoisted(() => ({
  api: {
    listTigerTemplates: vi.fn(),
    createTigerTemplate: vi.fn(),
    updateTigerTemplate: vi.fn(),
    duplicateTigerTemplate: vi.fn(),
    archiveTigerTemplate: vi.fn(),
    applyTigerTemplate: vi.fn(),
  },
  notices: {
    push: vi.fn(),
  },
}));

vi.mock('~/composables/useApi', () => ({
  useApi: () => mocks.api,
}));

vi.mock('~/stores/notices', () => ({
  useNoticesStore: () => mocks.notices,
}));

const validConfig = {
  claudeAgents: 1,
  codexAgents: 1,
  claudeModel: 'sonnet',
  codexModel: 'gpt-5',
  claudeEffort: 'medium',
  codexEffort: 'medium',
  claudePermission: 'dangerous',
  codexPermission: 'yolo',
  parallel: true,
  mergeAgent: 'claude' as const,
};

function template(overrides: Partial<TigerRunTemplate>): TigerRunTemplate {
  return {
    id: 'template-1',
    name: 'Custom',
    builtin: false,
    fromStage: 'writing-plan',
    configs: { 'writing-plan': validConfig },
    ...overrides,
  };
}

describe('templates store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('normalizes template CRUD responses and saved state', async () => {
    const { useTemplatesStore } = await import('~/stores/templates');
    const store = useTemplatesStore();
    const base = template({});
    const renamed = template({ name: 'Renamed', version: 2 });
    const copy = template({ id: 'copy-1', name: 'Renamed Copy' });

    mocks.api.listTigerTemplates.mockResolvedValue([base]);
    await store.load();
    expect(store.items).toEqual([base]);

    mocks.api.createTigerTemplate.mockResolvedValue([base, renamed]);
    await expect(
      store.create({ name: 'Renamed', fromStage: 'writing-plan', configs: renamed.configs }),
    ).resolves.toEqual(renamed);
    expect(store.items).toEqual([base, renamed]);
    expect(store.savedMessage).toBe('Template saved');

    mocks.api.updateTigerTemplate.mockResolvedValue({ ...renamed, description: 'Edited' });
    await store.update('template-1', { description: 'Edited' });
    expect(store.items.some((item) => item.description === 'Edited')).toBe(true);

    mocks.api.duplicateTigerTemplate.mockResolvedValue(copy);
    await expect(store.duplicate(renamed)).resolves.toEqual(copy);
    expect(store.items.some((item) => item.name === 'Renamed Copy')).toBe(true);

    mocks.api.archiveTigerTemplate.mockResolvedValue([base]);
    await store.archive(copy);
    expect(store.items).toEqual([base]);

    mocks.api.applyTigerTemplate.mockResolvedValue(base);
    await expect(store.apply(base)).resolves.toEqual(base);
    expect(mocks.notices.push).toHaveBeenCalledWith('Template applied', 'info');
  });

  it('keeps backend validation errors visible', async () => {
    const { useTemplatesStore } = await import('~/stores/templates');
    const store = useTemplatesStore();
    const error = {
      data: { error: { message: 'configs.writing-plan.claudeAgents must be between 1 and 8' } },
    };

    mocks.api.updateTigerTemplate.mockRejectedValue(error);
    await expect(store.update('template-1', { name: 'Invalid' })).rejects.toBe(error);

    expect(store.operationError).toBe('configs.writing-plan.claudeAgents must be between 1 and 8');
    expect(mocks.notices.push).toHaveBeenCalledWith(
      'Template save failed: configs.writing-plan.claudeAgents must be between 1 and 8',
      'error',
    );
  });
});
