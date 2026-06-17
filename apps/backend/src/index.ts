import http from 'node:http';
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
import { ensurePromptsDir } from './prompts/store.js';
import { createWsServer } from './ws/socket.js';
import { Orchestrator } from './orchestrator/Orchestrator.js';

const state = await loadState();
await ensurePromptsDir(); // create <repo>/prompts (or KAPLAN_PROMPTS_DIR) if missing
const manager = new TerminalManager();
manager.setDefinitions(state.terminals);
const orchestrator = new Orchestrator(manager);

const ctx: AppCtx = {
  state,
  manager,
  orchestrator,
  save: () => saveState(state),
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

app.use(express.json({ limit: '64kb' })); // payloads are tiny; cap well below any abuse

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', ok: true, terminals: state.terminals.length, dataDir: config.dataDir });
});

app.use('/api/terminals', createTerminalsRouter(ctx));
app.use('/api/groups', createGroupsRouter(ctx));
app.use('/api/settings', createSettingsRouter(ctx));
app.use('/api/fs', createFsRouter(ctx));

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
  autostartDone = manager.autostartAll();
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] shutting down — killing terminals...`);
  orchestrator.stopStage(); // abort any running stage so no new agents spawn
  manager.beginShutdown();
  await autostartDone.catch(() => {});
  await orchestrator.killAgents();
  await manager.killAll();
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
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
  void shutdown('uncaughtException');
});
