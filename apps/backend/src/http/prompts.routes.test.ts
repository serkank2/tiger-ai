import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AppCtx } from '../context.js';
import type { PromptHistoryListResponse } from '../repositories/PromptHistoryRepository.js';
import type { PersistedState } from '../store/types.js';
import { createPromptsRouter } from './prompts.routes.js';

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

function state(): PersistedState {
  return {
    schemaVersion: 1,
    terminals: [],
    groups: [],
    settings: {
      theme: 'system',
      defaultCwd: process.cwd(),
      defaultShell: { kind: 'system-default' },
      commandRouting: {
        appendNewlineByDefault: true,
        startTerminalOnSend: true,
      },
    },
    tiger: {},
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

async function listen(app: express.Express): Promise<TestServer> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const e = err as { status?: number; statusCode?: number; code?: string };
  const explicit =
    typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
  const status = explicit && explicit >= 400 && explicit < 600 ? explicit : 500;
  res.status(status).json({ error: { message: err instanceof Error ? err.message : String(err), code: e.code } });
}

test('GET /api/prompts/history returns filtered prompt history from the backend contract', async () => {
  let seenFilters: unknown = null;
  const history: PromptHistoryListResponse = {
    total: 1,
    items: [
      {
        id: 'hist-1',
        projectId: 'project-a',
        kind: 'generated',
        inputText: 'rough deploy note',
        outputText: 'Polished deploy prompt',
        generationId: 'gen-1',
        metadata: { terminalId: 'prompt-generation-gen-1' },
        createdAt: '2026-06-18T07:00:00.000Z',
        status: 'done',
        agentType: 'codex',
        model: 'gpt-5',
        error: null,
      },
    ],
  };
  const ctx: AppCtx = {
    state: state(),
    manager: {} as AppCtx['manager'],
    orchestrator: {} as AppCtx['orchestrator'],
    runTemplates: {} as AppCtx['runTemplates'],
    promptGenerations: {
      listHistory: async (filters: unknown) => {
        seenFilters = filters;
        return history;
      },
    } as AppCtx['promptGenerations'],
    queueService: {} as AppCtx['queueService'],
    limits: {} as AppCtx['limits'],
    teamOrchestrator: {} as AppCtx['teamOrchestrator'],
    teamTemplates: {} as AppCtx['teamTemplates'],
    teamTranslations: {} as AppCtx['teamTranslations'],
    save: async () => {},
  };

  const app = express();
  app.use('/api/prompts', express.json({ limit: '160kb' }), createPromptsRouter(ctx));
  app.use(errorHandler);
  const server = await listen(app);
  try {
    const res = await fetch(`${server.baseUrl}/api/prompts/history?text=deploy&kind=generated&status=done&limit=25`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), history);
    assert.deepEqual(seenFilters, { text: 'deploy', kind: 'generated', status: 'done', limit: 25 });
  } finally {
    await server.close();
  }
});
