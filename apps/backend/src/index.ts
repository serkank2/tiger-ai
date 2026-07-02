import http from 'node:http';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config.js';
import { logger } from './obs/logger.js';
import { metrics } from './obs/metrics.js';
import { errorHandler, httpError } from './http/errors.js';
import { requestContext } from './http/middleware/request-context.js';
import { requireAuth } from './http/middleware/auth.js';
import { rateLimit } from './http/middleware/rate-limit.js';
import { loadState, saveState } from './store/state.js';
import { TerminalManager } from './terminal/TerminalManager.js';
import type { AppCtx } from './context.js';
import { createTerminalsRouter } from './http/terminals.routes.js';
import { createGroupsRouter } from './http/groups.routes.js';
import { createSettingsRouter } from './http/settings.routes.js';
import { createFsRouter } from './http/fs.routes.js';
import { createPromptsRouter } from './http/prompts.routes.js';
import { createLimitsRouter } from './http/limits.routes.js';
import { createQueueRouter } from './http/queue.routes.js';
import { createCueRouter } from './http/cue.routes.js';
import { createRunsRouter } from './http/runs.routes.js';
import { RunEngine } from './run/engine.js';
import { CueEngine } from './cue/CueEngine.js';
import { ensurePromptsDir } from './prompts/store.js';
import { createWsServer } from './ws/socket.js';
import { closeDbPool, getDbPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { MySqlLimitRepository } from './repositories/LimitRepository.js';
import { MysqlQueueRepository } from './queue/MysqlQueueRepository.js';
import { ProviderConfigStore } from './providers/config-store.js';
import { createDefaultPromptGenerationService } from './services/PromptGenerationService.js';
import { LimitService } from './services/LimitService.js';
import { QueueService } from './services/QueueService.js';
import { Scheduler } from './queue/Scheduler.js';
import { isMcpEnabled, startMcpServer, type RunningMcpServer } from './mcp/server.js';

// MySQL is the durable system of record: connect and migrate BEFORE the server listens.
// If MySQL is unreachable after the retry window, fail fast with a clear error — never
// silently boot on file state.
try {
  await migrate(await getDbPool());
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err);
  logger.error('MySQL unavailable — refusing to start', {
    reason,
    hint: 'Start MySQL and check KAPLAN_DB_* settings (see apps/backend/.env.example).',
  });
  process.exit(1);
}

const state = await loadState();
await ensurePromptsDir(); // create <repo>/prompts (or KAPLAN_PROMPTS_DIR) if missing
const manager = new TerminalManager();
manager.setDefinitions(state.terminals);
const save = () => saveState(state);
// Global provider CLI configuration (executables/models/permission modes) — the
// single config source the run engine, prompt generation, and queue read.
const providerConfig = new ProviderConfigStore();
await providerConfig.initialize();
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

// v2 run engine: headless agent turns (stream-json / exec --json) over a
// WorkGraph — no PTYs, no marker files (docs/REDESIGN.md).
const runEngine = new RunEngine({ loadCliConfig: async () => providerConfig.getConfig() });
const promptGenerations = createDefaultPromptGenerationService(
  state,
  () => providerConfig.getConfig(),
  () => ({ projectId: runEngine.getSnapshot()?.workspace ?? null, tigerRoot: null }),
);
const queueScheduler = new Scheduler(queueService, {
  terminalTarget: { state, manager, save },
  runTarget: runEngine,
});

const ctx: AppCtx = {
  state,
  manager,
  promptGenerations,
  queueService,
  limits,
  runEngine,
  providerConfig,
  save,
};

await queueScheduler.start();

const app = express();
// Trust the loopback proxy chain so req.ip reflects the real client for rate limiting.
app.set('trust proxy', 'loopback');
// Per-request id + child logger + access log + request counter. First so everything downstream
// (and the central error handler) sees req.id / req.log.
app.use(requestContext());
// Security headers. CSP is left off by default — the API serves JSON, and the frontend is a
// separate origin, so a restrictive CSP here would only risk breaking dev tooling.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.corsOrigins }));
// Server-side Origin guard: block cross-origin browser requests outright (CORS only
// blocks reading the *response*; a simple cross-origin POST could still hit a route).
// Non-browser local clients send no Origin and are allowed.
app.use((req, _res, next) => {
  const origin = req.headers.origin;
  if (origin && !config.corsOrigins.includes(origin)) {
    next(httpError(403, 'forbidden_origin', 'forbidden origin'));
    return;
  }
  next();
});

// Liveness endpoint: exempt from auth and rate limiting (orchestrators probe it aggressively).
// Mounted app-wide (not under '/api') so req.path keeps the full prefix for the skip checks.
const isLiveness = (req: { path: string }): boolean => req.path === '/api/health/live';
const isApi = (req: { path: string }): boolean => req.path.startsWith('/api/') || req.path === '/api';
// Optional shared-token auth on /api/* (no-op when KAPLAN_AUTH_TOKEN is unset).
app.use(requireAuth({ skip: (req) => !isApi(req) || isLiveness(req) }));
// Per-IP fixed-window abuse guard (honors config.rateLimit; skips the liveness probe).
if (config.rateLimit.enabled) {
  app.use(rateLimit({ skip: isLiveness }));
}

// Prompt bodies are larger than the rest of the API; give this router its own bigger
// JSON parser, mounted BEFORE the global 64kb cap so prompt writes aren't pre-limited.
app.use('/api/prompts', express.json({ limit: '160kb' }), createPromptsRouter(ctx));

app.use('/api/queue', express.json({ limit: '2mb' }), createQueueRouter(ctx));
// v2 runs: goals can be long documents; give this router a roomier parser.
app.use('/api/runs', express.json({ limit: '2mb' }), createRunsRouter(ctx));

app.use(express.json({ limit: '64kb' })); // payloads are tiny; cap well below any abuse

// Liveness: the process is up and serving. Always 200, no I/O — for restart-on-crash probes.
app.get('/api/health/live', (_req, res) => {
  res.json({ status: 'ok', uptimeSec: Math.round(process.uptime()) });
});

// Readiness: only 200 when the durable store is reachable, else 503 — for load-balancer gating.
app.get('/api/health/ready', async (_req, res) => {
  const dbReady = await pingDb();
  res.status(dbReady ? 200 : 503).json({
    status: dbReady ? 'ok' : 'unavailable',
    db: { ready: dbReady, name: config.db.database },
  });
});

// Back-compat combined health (existing clients depend on this shape).
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

// Metrics scrape (Prometheus text by default, JSON via ?format=json). Auth-gated together with
// the rest of /api when a token is configured; open when auth is disabled (local default).
app.get('/api/metrics', async (req, res) => {
  if (req.query.format === 'json') {
    res.json(metrics.renderJson());
    return;
  }
  res.type('text/plain; version=0.0.4').send(metrics.renderText());
});

app.use('/api/terminals', createTerminalsRouter(ctx));
app.use('/api/groups', createGroupsRouter(ctx));
app.use('/api/settings', createSettingsRouter(ctx));
app.use('/api/fs', createFsRouter(ctx));
app.use('/api/limits', createLimitsRouter(ctx));

// Cue: event-driven orchestration engine. Engine construction is config-gated (OFF by default),
// but the route is always mounted so disabled clients get a stable 409 instead of a 404.
let cueEngine: CueEngine | null = null;
if (config.cue.enabled) {
  cueEngine = new CueEngine({ ctx, workspace: config.cue.workspace || null });
}
app.use(
  '/api/cue',
  createCueRouter(ctx, () => cueEngine),
);

// Central error handler (Express 5 forwards rejected async handlers here).
app.use(errorHandler());

const server = http.createServer(app);
const wss = createWsServer(server, ctx);

// Live gauges, computed from the real ctx on every /metrics scrape (never stale).
const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled']); // queue jobs no longer "in flight"
let lastQueueDepth = 0;
queueService.on('state', (s: import('./queue/types.js').QueueState) => {
  lastQueueDepth = s.jobs.filter((j) => !TERMINAL_STATES.has(j.status)).length;
});
metrics.setGauge('queue_depth', () => lastQueueDepth);
metrics.setGauge('terminal_count', () => state.terminals.length);
metrics.setGauge(
  'terminal_running_count',
  () => state.terminals.filter((t) => manager.getStatus(t.id)?.state === 'running').length,
);
metrics.setGauge('ws_peers', () => wss.clients.size);
metrics.setGauge('process_uptime_seconds', () => Math.round(process.uptime()));
metrics.setGauge('process_resident_memory_bytes', () => process.memoryUsage().rss);

let autostartDone: Promise<void> = Promise.resolve();

server.listen(config.port, config.host, () => {
  logger.info('Kaplan backend listening', {
    rest: `http://${config.host}:${config.port}/api`,
    ws: `ws://${config.host}:${config.port}/ws`,
    state: config.stateFile,
    auth: config.auth.enabled ? 'enabled' : 'disabled',
  });
  limits.start();
  autostartDone = manager.autostartAll();
  // Start the Cue engine (config-gated above). Failure here must never take down the server.
  if (cueEngine) void cueEngine.start().catch((err) => logger.error('cue engine failed to start', { err }));
});

// Optional MCP (Model Context Protocol) board server — config-gated, OFF by default
// (set KAPLAN_MCP_ENABLED=1). Exposes the queue/Tiger/Team board to coding agents over stdio.
let mcp: RunningMcpServer | null = null;
if (isMcpEnabled()) mcp = await startMcpServer(ctx);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down — killing terminals', { signal });
  queueScheduler.stop();
  if (cueEngine) await cueEngine.stop().catch(() => {});
  if (mcp) await mcp.close().catch(() => {});
  // v2 runs: abort in-flight headless turns (kills the process trees, persists state).
  if (runEngine.getSnapshot()?.status === 'running') await runEngine.stop('Backend shutting down.').catch(() => {});
  limits.stop();
  manager.beginShutdown();
  await autostartDone.catch(() => {});
  await manager.killAll();

  // Safety net: if draining hangs on lingering sockets, force exit so shutdown can't wedge.
  const forceExit = setTimeout(() => process.exit(0), 5000);
  forceExit.unref();

  // Drain network first, THEN release the DB pool. Closing the pool before the HTTP/WS
  // servers would leave in-flight requests during the grace window hitting a dead pool.
  // Stop accepting new connections and wait for the WS server then the HTTP server to close;
  // only after the network is drained do we release the DB pool.
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDbPool();
  clearTimeout(forceExit);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// A single stray rejected promise must NOT tear down every running agent. Log it (with the
// structured logger) and keep serving; only a truly unrecoverable `uncaughtException` (below)
// warrants a full shutdown that kills child ptys.
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { err: reason });
});

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
  logger.error('uncaughtException', { err });
  void shutdown('uncaughtException');
});
