import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { config } from './config.js';
import { loadState, saveState } from './store/state.js';
import { TerminalManager } from './terminal/TerminalManager.js';
import type { AppCtx } from './context.js';
import { createTerminalsRouter } from './http/terminals.routes.js';
import { createGroupsRouter } from './http/groups.routes.js';
import { createSettingsRouter } from './http/settings.routes.js';
import { createFsRouter } from './http/fs.routes.js';
import { createPromptsRouter } from './http/prompts.routes.js';
import { createTigerRouter } from './http/tiger.routes.js';
import { createLimitsRouter } from './http/limits.routes.js';
import { createQueueRouter } from './http/queue.routes.js';
import { ensurePromptsDir } from './prompts/store.js';
import { createWsServer } from './ws/socket.js';
import { Orchestrator } from './orchestrator/Orchestrator.js';
import { MySqlExecutionPersistence } from './orchestrator/persistence.js';
import { closeDbPool, getDbPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { MySqlRunTemplateRepository } from './repositories/run-templates.js';
import { MySqlLimitRepository } from './repositories/LimitRepository.js';
import { MysqlQueueRepository } from './queue/MysqlQueueRepository.js';
import { RunTemplateService } from './services/run-templates.js';
import { createDefaultPromptGenerationService } from './services/PromptGenerationService.js';
import { LimitService } from './services/LimitService.js';
import { QueueService } from './services/QueueService.js';
import { Scheduler } from './queue/Scheduler.js';

// MySQL is the durable system of record: connect and migrate BEFORE the server listens.
// If MySQL is unreachable after the retry window, fail fast with a clear error — never
// silently boot on file state.
try {
  await migrate(await getDbPool());
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err);
  console.error('\n  ❌ Kaplan backend: MySQL unavailable — refusing to start.');
  console.error(`     ${reason}`);
  console.error('     Start MySQL and check KAPLAN_DB_* settings (see apps/backend/.env.example).\n');
  process.exit(1);
}

const state = await loadState();
await ensurePromptsDir(); // create <repo>/prompts (or KAPLAN_PROMPTS_DIR) if missing
const manager = new TerminalManager();
manager.setDefinitions(state.terminals);
const dbPool = await getDbPool();
const save = () => saveState(state);
const orchestrator = new Orchestrator(manager, {
  persistence: new MySqlExecutionPersistence(dbPool),
});
const runTemplates = new RunTemplateService(new MySqlRunTemplateRepository(dbPool), () =>
  orchestrator.getConfig(),
);
orchestrator.setRunTemplateService(runTemplates);
const limits = new LimitService({
  manager,
  state,
  save,
  repository: new MySqlLimitRepository(),
  intervalMs: config.limitProbeIntervalMs,
  staleAfterMs: config.limitStaleAfterMs,
});
await limits.initialize();
const queueService = new QueueService(new MysqlQueueRepository());
const queueScheduler = new Scheduler(queueService, orchestrator);
const promptGenerations = createDefaultPromptGenerationService(manager, state, () => orchestrator.getConfig(), () => {
  const tiger = orchestrator.getState();
  return { projectId: tiger.workspace, tigerRoot: tiger.tigerRoot };
});

const ctx: AppCtx = {
  state,
  manager,
  orchestrator,
  runTemplates,
  promptGenerations,
  queueService,
  limits,
  save,
};

// Tiger opens to a project launcher (no auto-attach). Migrate a legacy lastWorkspace into the
// projects list so existing projects still appear in the launcher.
if (state.tiger?.lastWorkspace) {
  state.tiger.projects ??= [];
  if (!state.tiger.projects.includes(state.tiger.lastWorkspace)) {
    state.tiger.projects.push(state.tiger.lastWorkspace);
    void saveState(state);
  }
}

await runTemplates.initialize({
  legacyTemplateDirs: legacyRunTemplateDirs(state.tiger?.projects ?? []),
});
await queueScheduler.start();

const app = express();
app.use(cors({ origin: config.corsOrigins }));
// Server-side Origin guard: block cross-origin browser requests outright (CORS only
// blocks reading the *response*; a simple cross-origin POST could still hit a route).
// Non-browser local clients send no Origin and are allowed.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !config.corsOrigins.includes(origin)) {
    res.status(403).json({ error: { message: 'forbidden origin' } });
    return;
  }
  next();
});

// Prompt bodies are larger than the rest of the API; give this router its own bigger
// JSON parser, mounted BEFORE the global 64kb cap so prompt writes aren't pre-limited.
app.use('/api/prompts', express.json({ limit: '160kb' }), createPromptsRouter(ctx));

// Tiger accepts a full project prompt (can be large) on /workspace — give it a roomier parser
// mounted before the global tight cap.
app.use('/api/tiger', express.json({ limit: '2mb' }), createTigerRouter(ctx));
app.use('/api/queue', express.json({ limit: '2mb' }), createQueueRouter(ctx));

app.use(express.json({ limit: '64kb' })); // payloads are tiny; cap well below any abuse

app.get('/api/health', async (_req, res) => {
  const dbReady = await pingDb();
  res.json({
    status: dbReady ? 'ok' : 'degraded',
    ok: dbReady,
    db: { ready: dbReady, name: config.db.database },
    terminals: state.terminals.length,
    dataDir: config.dataDir,
  });
});

app.use('/api/terminals', createTerminalsRouter(ctx));
app.use('/api/groups', createGroupsRouter(ctx));
app.use('/api/settings', createSettingsRouter(ctx));
app.use('/api/fs', createFsRouter(ctx));
app.use('/api/limits', createLimitsRouter(ctx));

// Central error handler (Express 5 forwards rejected async handlers here).
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const e = err as { code?: string; status?: number; statusCode?: number };
  const explicit = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
  // Honor Express/body-parser statuses (400 malformed JSON, 413 too large, ...).
  const httpStatus =
    explicit && explicit >= 400 && explicit < 600 ? explicit : e.code === 'EINVAL_CWD' ? 400 : 500;
  const rawMessage = err instanceof Error ? err.message : String(err);
  if (httpStatus >= 500) console.error('[api] unhandled error:', err);
  // Don't leak internal messages (e.g. absolute fs paths) on 5xx; client only needs 4xx detail.
  res.status(httpStatus).json({ error: { message: httpStatus >= 500 ? 'internal server error' : rawMessage, code: e.code } });
});

const server = http.createServer(app);
const wss = createWsServer(server, ctx);

let autostartDone: Promise<void> = Promise.resolve();

server.listen(config.port, config.host, () => {
  console.log(`\n  🐅 Kaplan backend`);
  console.log(`     REST   http://${config.host}:${config.port}/api`);
  console.log(`     WS     ws://${config.host}:${config.port}/ws`);
  console.log(`     state  ${config.stateFile}\n`);
  limits.start();
  autostartDone = manager.autostartAll();
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] shutting down — killing terminals...`);
  queueScheduler.stop();
  orchestrator.stopStage(); // abort any running stage so no new agents spawn
  limits.stop();
  manager.beginShutdown();
  await autostartDone.catch(() => {});
  await orchestrator.killAgents();
  await manager.killAll();
  await closeDbPool();
  wss.close();
  server.close(() => process.exit(0));
  // Safety net if server.close hangs on lingering sockets.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// Last-resort: kill child ptys instead of leaving them orphaned on an unexpected crash.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
  void shutdown('unhandledRejection');
});

function legacyRunTemplateDirs(projects: string[]): string[] {
  const dirs = new Set<string>();
  dirs.add(path.join(config.repoRoot, '.tiger', 'run-templates'));
  for (const project of projects) dirs.add(path.join(project, '.tiger', 'run-templates'));
  return [...dirs];
}

async function pingDb(): Promise<boolean> {
  try {
    const pool = await getDbPool();
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
  void shutdown('uncaughtException');
});
