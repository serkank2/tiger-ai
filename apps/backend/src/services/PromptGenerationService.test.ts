import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TerminalManager } from '../terminal/TerminalManager.js';
import { defaultTigerConfig } from '../orchestrator/config.js';
import type { TigerTiming } from '../orchestrator/types.js';
import { StateLimitGate, StaticLimitGate, type LimitGate } from '../limits/gate.js';
import {
  defaultLimitRules,
  type LimitRuleDecision,
  type LimitSnapshot,
  type LimitsPersistedState,
} from '../limits/types.js';
import {
  InMemoryPromptGenerationRepository,
  type PromptGenerationRecord,
} from '../repositories/PromptGenerationRepository.js';
import { InMemoryPromptHistoryRepository } from '../repositories/PromptHistoryRepository.js';
import { PromptGenerationService, type PromptGenerationTerminalFactory } from './PromptGenerationService.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'orchestrator', 'fake-cli.mjs');
const NOW = new Date('2026-06-18T06:00:00.000Z');

function timing(overrides: Partial<TigerTiming> = {}): TigerTiming {
  return {
    readyIdleMs: 300,
    readyMaxWaitMs: 4000,
    doneIdleMs: 60000,
    markerPollMs: 100,
    agentTimeoutMs: 6000,
    settleMaxWaitMs: 1500,
    submitDelayMs: 100,
    ...overrides,
  };
}

function allowDecision(): LimitRuleDecision {
  return {
    allowed: true,
    action: 'allow',
    reason: 'test allow',
    resumeAfter: null,
    conservative: false,
    checkedAt: new Date().toISOString(),
  };
}

function blockDecision(): LimitRuleDecision {
  return {
    allowed: false,
    action: 'block',
    reason: 'test limit reached',
    ruleId: 'test-rule',
    resumeAfter: '2026-06-18T12:00:00.000Z',
    conservative: false,
    checkedAt: new Date().toISOString(),
  };
}

function snapshot(input: Partial<LimitSnapshot>): LimitSnapshot {
  const percentUsed = input.percentUsed === undefined ? 0 : input.percentUsed;
  return {
    id: input.id ?? 'snapshot',
    provider: input.provider ?? 'claude',
    windowKey: input.windowKey ?? '5h',
    label: input.label ?? '5h limit',
    percentUsed,
    metricRaw:
      input.metricRaw === undefined
        ? percentUsed === null
          ? null
          : { percent: percentUsed, metric: 'used' }
        : input.metricRaw,
    resetText: input.resetText ?? 'resets in 1h',
    resetAt: input.resetAt === undefined ? '2026-06-18T07:00:00.000Z' : input.resetAt,
    ok: input.ok ?? true,
    error: input.error,
    rawPanel: input.rawPanel ?? '',
    parseConfidence: input.parseConfidence ?? 'trusted',
    checkedAt: input.checkedAt ?? NOW.toISOString(),
  };
}

function limits(snapshots: LimitSnapshot[]): LimitsPersistedState {
  return {
    snapshots,
    rules: defaultLimitRules('2026-06-18T00:00:00.000Z'),
  };
}

function fakeTerminalFactory(mode: string, launched: { count: number }): PromptGenerationTerminalFactory {
  return (params) => {
    launched.count += 1;
    const now = new Date().toISOString();
    return {
      id: params.id,
      name: params.name,
      groupId: null,
      cwd: params.cwd,
      shell: {
        kind: 'custom',
        path: process.execPath,
        args: [FAKE, '--out', params.outputPath, '--marker', params.markerPath, '--mode', mode],
      },
      protected: true,
      createdAt: now,
      updatedAt: now,
    };
  };
}

async function waitFor(
  service: PromptGenerationService,
  id: string,
  predicate: (generation: PromptGenerationRecord) => boolean,
): Promise<PromptGenerationRecord> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const generation = await service.get(id);
    if (generation && predicate(generation)) return generation;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`prompt generation ${id} did not reach expected state`);
}

async function withService(
  mode: string,
  fn: (args: {
    service: PromptGenerationService;
    repo: InMemoryPromptGenerationRepository;
    history: InMemoryPromptHistoryRepository;
    launched: { count: number };
  }) => Promise<void>,
  options: { limitGate?: LimitGate } = {},
): Promise<void> {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-prompt-generation-'));
  const manager = new TerminalManager();
  const repo = new InMemoryPromptGenerationRepository();
  const history = new InMemoryPromptHistoryRepository();
  const launched = { count: 0 };
  const service = new PromptGenerationService({
    manager,
    repository: repo,
    historyRepository: history,
    limitGate: options.limitGate ?? new StaticLimitGate(allowDecision()),
    getConfig: defaultTigerConfig,
    getProjectContext: () => ({ projectId: 'test-project', tigerRoot: runtimeDir }),
    runtimeRoot: () => runtimeDir,
    terminalFactory: fakeTerminalFactory(mode, launched),
    timing: timing(),
  });
  try {
    await fn({ service, repo, history, launched });
  } finally {
    await manager.killAll().catch(() => {});
    await fs.rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
}

test('prompt generation persists input and non-empty fake CLI output', async () => {
  await withService('marker', async ({ service, repo, history, launched }) => {
    let historyChanged = 0;
    service.on('history.changed', () => {
      historyChanged += 1;
    });

    const started = await service.start({ inputText: 'rough draft: build a project plan', agentType: 'claude' });
    assert.equal(started.status, 'pending');

    const done = await waitFor(service, started.id, (generation) => generation.status === 'done');
    assert.equal(done.inputText, 'rough draft: build a project plan');
    assert.match(done.outputText ?? '', /Generated by fake-cli/);
    assert.equal(done.projectId, 'test-project');
    assert.equal(launched.count, 1);

    const persisted = await repo.get(started.id);
    assert.equal(persisted?.status, 'done');
    assert.match(persisted?.outputText ?? '', /Generated by fake-cli/);
    assert.equal(history.events.length, 1);
    assert.equal(history.events[0]?.kind, 'generated');
    assert.equal(history.events[0]?.generationId, started.id);
    assert.equal(historyChanged, 1);
  });
});

test('prompt generation emits history.changed after reuse history records', async () => {
  await withService('marker', async ({ service, history }) => {
    let historyChanged = 0;
    service.on('history.changed', () => {
      historyChanged += 1;
    });

    const started = await service.start({ inputText: 'rough draft to reuse', agentType: 'codex' });
    const done = await waitFor(service, started.id, (generation) => generation.status === 'done');
    assert.equal(historyChanged, 1);

    await service.recordReuseAction(done.id, 'save-to-library', { path: 'generated/reused.md' });
    assert.equal(history.events.length, 2);
    assert.equal(history.events[1]?.kind, 'saved_to_library');
    assert.equal(historyChanged, 2);
  });
});

test('prompt generation does not launch provider work when limit gate blocks', async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kaplan-prompt-generation-block-'));
  const manager = new TerminalManager();
  const launched = { count: 0 };
  const service = new PromptGenerationService({
    manager,
    repository: new InMemoryPromptGenerationRepository(),
    historyRepository: new InMemoryPromptHistoryRepository(),
    limitGate: new StaticLimitGate(blockDecision()),
    getConfig: defaultTigerConfig,
    getProjectContext: () => ({ projectId: 'test-project', tigerRoot: runtimeDir }),
    runtimeRoot: () => runtimeDir,
    terminalFactory: fakeTerminalFactory('marker', launched),
    timing: timing(),
  });
  try {
    const started = await service.start({ inputText: 'rough draft', agentType: 'claude' });
    const failed = await waitFor(service, started.id, (generation) => generation.status === 'failed');
    assert.equal(launched.count, 0);
    assert.match(failed.error ?? '', /limit gate blocked/);
  } finally {
    await manager.killAll().catch(() => {});
    await fs.rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('prompt generation launches provider work when no limit snapshot exists', async () => {
  await withService(
    'marker',
    async ({ service, launched }) => {
      const started = await service.start({ inputText: 'rough draft', agentType: 'claude' });
      const done = await waitFor(service, started.id, (generation) => generation.status === 'done');

      assert.equal(launched.count, 1);
      assert.equal(done.error, null);
      assert.match(done.outputText ?? '', /Generated by fake-cli/);
    },
    {
      limitGate: new StateLimitGate(() => limits([]), { now: NOW, staleAfterMs: 60_000 }),
    },
  );
});

test('prompt generation launches provider work when limit snapshot is stale', async () => {
  await withService(
    'marker',
    async ({ service, launched }) => {
      const started = await service.start({ inputText: 'rough draft', agentType: 'claude' });
      const done = await waitFor(service, started.id, (generation) => generation.status === 'done');

      assert.equal(launched.count, 1);
      assert.equal(done.error, null);
      assert.match(done.outputText ?? '', /Generated by fake-cli/);
    },
    {
      limitGate: new StateLimitGate(
        () => limits([snapshot({ percentUsed: 10, checkedAt: '2026-06-18T05:00:00.000Z' })]),
        { now: NOW, staleAfterMs: 10 * 60 * 1000 },
      ),
    },
  );
});

test('prompt generation launches provider work when latest provider probe failed', async () => {
  await withService(
    'marker',
    async ({ service, launched }) => {
      const started = await service.start({ inputText: 'rough draft', agentType: 'claude' });
      const done = await waitFor(service, started.id, (generation) => generation.status === 'done');

      assert.equal(launched.count, 1);
      assert.equal(done.error, null);
      assert.match(done.outputText ?? '', /Generated by fake-cli/);
    },
    {
      limitGate: new StateLimitGate(
        () =>
          limits([
            snapshot({ id: 'ok', percentUsed: 10, checkedAt: '2026-06-18T05:55:00.000Z' }),
            snapshot({
              id: 'failed',
              windowKey: 'probe',
              label: 'Probe',
              percentUsed: null,
              metricRaw: null,
              ok: false,
              error: 'cli unavailable',
              resetAt: null,
              parseConfidence: 'unknown',
              checkedAt: NOW.toISOString(),
            }),
          ]),
        { now: NOW, staleAfterMs: 60_000 },
      ),
    },
  );
});

test('prompt generation rejects an injectable Antigravity model override before launching', async () => {
  // Review finding 1: an arbitrary model string with quotes/metacharacters must be rejected before
  // a launch command is built — it must never reach buildLaunchCommand or spawn a terminal.
  await withService('marker', async ({ service, launched }) => {
    await assert.rejects(
      () => service.start({ inputText: 'draft', agentType: 'antigravity', model: 'Gemini 3.1 Pro" ; rm -rf / #' }),
      /not a valid antigravity model/i,
    );
    await assert.rejects(
      () => service.start({ inputText: 'draft', agentType: 'antigravity', effort: 'high' }),
      /not a valid antigravity effort/i,
    );
    await assert.rejects(
      () => service.start({ inputText: 'draft', agentType: 'claude', permission: 'no-such-mode' }),
      /not a known claude permission mode/i,
    );
    assert.equal(launched.count, 0);
  });
});

test('prompt generation accepts a valid Antigravity model label override', async () => {
  await withService('marker', async ({ service, launched }) => {
    const started = await service.start({
      inputText: 'draft',
      agentType: 'antigravity',
      model: 'Gemini 3.1 Pro (High)',
    });
    const done = await waitFor(service, started.id, (generation) => generation.status === 'done');
    assert.equal(done.model, 'Gemini 3.1 Pro (High)');
    assert.equal(launched.count, 1);
  });
});

test('prompt generation records failed status when the agent produces no output', async () => {
  await withService('missing', async ({ service, history, launched }) => {
    const started = await service.start({ inputText: 'rough draft', agentType: 'claude' });
    const failed = await waitFor(service, started.id, (generation) => generation.status === 'failed');
    assert.equal(launched.count, 1);
    assert.equal(failed.outputText, null);
    assert.match(failed.error ?? '', /output/i);
    assert.equal(history.events.length, 0);
  });
});
