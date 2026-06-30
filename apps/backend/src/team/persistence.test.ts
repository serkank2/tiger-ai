import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'mysql2/promise';
import { migrate } from '../db/migrate.js';
import {
  MemoryTeamPersistence,
  MySqlTeamPersistence,
  NoopTeamPersistence,
  TEAM_MIGRATION,
  TEAM_TEMPLATES_MIGRATION,
  type TeamMessageRecord,
  type TeamOwner,
  type TeamPersistence,
} from './persistence.js';

const WS = '/tmp/ws';
const TIGER_ROOT = '/tmp/ws/.tiger';
const OWNER: TeamOwner = { type: 'manual', id: 'pid-1' };

const TEAM_TABLES = [
  'team_runs',
  'team_roles',
  'team_messages',
  'team_turns',
  'team_directives',
  'team_signoffs',
  'team_verifications',
  'team_templates',
];

// All three implementations must satisfy the full interface (compile-time check).
const IMPLEMENTATIONS: TeamPersistence[] = [
  new NoopTeamPersistence(),
  new MemoryTeamPersistence(),
  new MySqlTeamPersistence(),
];
void IMPLEMENTATIONS;

test('MemoryTeamPersistence round-trip: create run -> roles -> messages -> sign-off -> load', async () => {
  const p = new MemoryTeamPersistence();

  const run = await p.createRun({
    workspace: WS,
    tigerRoot: TIGER_ROOT,
    owner: OWNER,
    ttlMs: 60_000,
    goal: 'Build feature X',
    templateId: 'tmpl-standard',
  });
  assert.ok(run.id, 'run id is generated');
  assert.equal(run.status, 'running');
  assert.equal(run.goal, 'Build feature X');
  assert.equal(run.templateId, 'tmpl-standard');
  assert.equal(run.leaseOwner, 'manual:pid-1');
  assert.equal(run.seqCursor, 0);

  const roles = await p.saveRoles(run.id, [
    { roleKey: 'lead', name: 'Lead', agentType: 'claude', requiredForSignoff: true },
    { roleKey: 'developer', name: 'Developer', agentType: 'codex', canWriteCode: true, permission: 'workspace-write' },
  ]);
  assert.equal(roles.length, 2);

  const m1 = await p.appendMessage({
    runId: run.id,
    fromKind: 'role',
    fromRole: 'lead',
    kind: 'chat',
    body: 'Kickoff',
  });
  const m2 = await p.appendMessage({
    runId: run.id,
    fromKind: 'role',
    fromRole: 'developer',
    kind: 'handoff',
    body: 'On it',
  });
  const m3 = await p.appendMessage({ runId: run.id, fromKind: 'user', kind: 'steering', body: 'Focus on auth' });
  assert.deepEqual([m1.seq, m2.seq, m3.seq], [1, 2, 3], 'seq is assigned monotonically');

  const signoff = await p.recordSignoff({ runId: run.id, roleKey: 'lead', signedOff: true, summary: 'All good' });
  assert.equal(signoff.signedOff, true);

  const loaded = await p.loadRun(run.id);
  assert.ok(loaded, 'run loads back');
  assert.equal(loaded.run.id, run.id);
  assert.equal(loaded.run.goal, 'Build feature X');
  assert.equal(loaded.roles.length, 2);
  assert.equal(loaded.signoffs.length, 1);
  assert.equal(loaded.signoffs[0]?.roleKey, 'lead');
  assert.equal(loaded.signoffs[0]?.signedOff, true);

  const messages = await p.listMessages(run.id);
  assert.deepEqual(
    messages.map((m) => m.body),
    ['Kickoff', 'On it', 'Focus on auth'],
    'messages return in append (seq) order',
  );
  assert.deepEqual(
    messages.map((m) => m.seq),
    [1, 2, 3],
  );
});

test('listMessages(runId, afterSeq) returns strictly increasing seq order', async () => {
  const p = new MemoryTeamPersistence();
  const run = await p.createRun({ workspace: WS, tigerRoot: TIGER_ROOT, owner: OWNER, ttlMs: 60_000 });

  // Append out of "natural" insertion timing to prove ordering is by seq, not arrival.
  for (let i = 0; i < 25; i += 1) {
    await p.appendMessage({ runId: run.id, fromKind: 'system', kind: 'system', body: `m${i}` });
  }

  const all = await p.listMessages(run.id);
  assertStrictlyIncreasing(all);
  assert.equal(all.length, 25);
  assert.equal(all[0]?.seq, 1);
  assert.equal(all[all.length - 1]?.seq, 25);

  const afterCursor = await p.listMessages(run.id, 10);
  assertStrictlyIncreasing(afterCursor);
  assert.equal(afterCursor.length, 15);
  assert.equal(afterCursor[0]?.seq, 11, 'afterSeq is exclusive');

  const windowed = await p.listMessages(run.id, 10, 5);
  assert.deepEqual(
    windowed.map((m) => m.seq),
    [11, 12, 13, 14, 15],
    'limit windows the cursor result',
  );
});

test('MemoryTeamPersistence records turns, directives, verifications and reflects them in loadRun', async () => {
  const p = new MemoryTeamPersistence();
  const run = await p.createRun({ workspace: WS, tigerRoot: TIGER_ROOT, owner: OWNER, ttlMs: 60_000 });

  const turn = await p.recordTurn({ runId: run.id, roleKey: 'developer', ordinal: 1, status: 'running' });
  await p.recordTurn({ id: turn.id, runId: run.id, roleKey: 'developer', ordinal: 1, status: 'done' });
  const directive = await p.recordDirective({ runId: run.id, targetRole: 'developer', body: 'Prioritize tests' });
  const verification = await p.recordVerification({
    runId: run.id,
    roleKey: 'tester',
    kind: 'test',
    passed: true,
    summary: '12/12 green',
  });

  const loaded = await p.loadRun(run.id);
  assert.ok(loaded);
  assert.equal(loaded.turns.length, 1, 'recordTurn upserts by id');
  assert.equal(loaded.turns[0]?.status, 'done');
  assert.equal(loaded.directives.length, 1);
  assert.equal(loaded.directives[0]?.id, directive.id);
  assert.equal(loaded.verifications.length, 1);
  assert.equal(loaded.verifications[0]?.id, verification.id);
  assert.equal(loaded.verifications[0]?.passed, true);
});

test('run lease: conflict, refresh and finish', async () => {
  const p = new MemoryTeamPersistence();
  const run = await p.createRun({ workspace: WS, tigerRoot: TIGER_ROOT, owner: OWNER, ttlMs: 60_000 });

  const conflict = await p.acquireRunLease(run.id, { type: 'manual', id: 'pid-2' }, 60_000);
  assert.equal(conflict.ok, false, 'a different owner cannot steal an active lease');

  const sameOwner = await p.acquireRunLease(run.id, OWNER, 60_000);
  assert.equal(sameOwner.ok, true, 'the holding owner can re-acquire');

  await p.refreshRunLease(run.id, OWNER, 120_000);
  await p.finishRun(run.id, 'completed', 'done');
  const loaded = await p.loadRun(run.id);
  assert.equal(loaded?.run.status, 'completed');
  assert.equal(loaded?.run.leaseOwner, null, 'finishRun clears the lease');
});

test('reconcileTeamOnBoot interrupts stale running runs and their active turns', async () => {
  const p = new MemoryTeamPersistence();
  const run = await p.createRun({
    workspace: WS,
    tigerRoot: TIGER_ROOT,
    owner: { type: 'manual', id: 'old' },
    ttlMs: 1_000,
  });
  await p.recordTurn({ runId: run.id, roleKey: 'developer', status: 'running' });

  // Force the lease to be expired so a fresh boot owner treats it as stale.
  const stored = p.runs.get(run.id);
  assert.ok(stored);
  stored.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();

  const result = await p.reconcileTeamOnBoot({ workspace: WS, owner: { type: 'manual', id: 'new' }, ttlMs: 60_000 });
  assert.equal(result.interruptedRuns, 1);
  assert.equal(result.interruptedTurns, 1);

  const loaded = await p.loadRun(run.id);
  assert.equal(loaded?.run.status, 'interrupted');
  assert.equal(loaded?.turns[0]?.status, 'interrupted');
});

test('NoopTeamPersistence satisfies the interface without storing anything', async () => {
  const p: TeamPersistence = new NoopTeamPersistence();
  const run = await p.createRun({ workspace: WS, tigerRoot: TIGER_ROOT, owner: OWNER, ttlMs: 60_000 });
  assert.ok(run.id);
  const lease = await p.acquireRunLease(run.id, OWNER, 60_000);
  assert.equal(lease.ok, true);
  await p.saveRoles(run.id, [{ roleKey: 'lead', name: 'Lead', agentType: 'claude' }]);
  const msg = await p.appendMessage({ runId: run.id, fromKind: 'system', kind: 'system', body: 'noop' });
  assert.equal(msg.seq, 1);
  assert.deepEqual(await p.listMessages(run.id), []);
  assert.equal(await p.loadRun(run.id), null);
  const reconcile = await p.reconcileTeamOnBoot({ workspace: WS, owner: OWNER, ttlMs: 60_000 });
  assert.deepEqual(reconcile, { interruptedRuns: 0, interruptedRoles: 0, interruptedTurns: 0 });
});

test('TEAM_MIGRATION is idempotent by construction and leaves existing schema untouched', () => {
  assert.ok(TEAM_MIGRATION.id.length > 0, 'migration has a stable id');

  for (const table of TEAM_TABLES) {
    const stmt = TEAM_MIGRATION.statements.find((s) =>
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(s),
    );
    assert.ok(stmt, `migration creates ${table}`);
  }

  // Every statement is a guarded CREATE so re-applying is inherently safe.
  for (const stmt of TEAM_MIGRATION.statements) {
    assert.match(stmt, /^\s*CREATE TABLE IF NOT EXISTS/i);
  }

  const joined = TEAM_MIGRATION.statements.join('\n');
  assert.ok(!/\bALTER\s+TABLE\b/i.test(joined), 'no ALTER TABLE on any table');
  assert.ok(!/\bDROP\s+TABLE\b/i.test(joined), 'no DROP TABLE');
  assert.ok(
    !/execution_runs|run_stages|agent_runs|run_templates|queue_jobs|limit_rules/i.test(joined),
    'does not touch existing/execution tables',
  );

  // team_messages is ordered by a monotonic, unique-per-run seq.
  const teamMessages = TEAM_MIGRATION.statements.find((s) => /CREATE TABLE IF NOT EXISTS team_messages\b/i.test(s));
  assert.ok(teamMessages);
  assert.match(teamMessages, /seq\s+BIGINT/i);
  assert.match(teamMessages, /UNIQUE KEY[\s\S]*\(run_id, seq\)/i);
  assert.match(teamMessages, /INDEX[\s\S]*\(run_id, seq\)/i);
});

test('team_templates schema matches MySqlTeamTemplateRepository (FINDING-003 regression)', () => {
  // MySqlTeamTemplateRepository (repositories/team-templates.ts) reads and writes
  // exactly these columns; the migrated table must provide every one of them.
  const REQUIRED_COLUMNS = [
    'id',
    'name',
    'description',
    'roles_json',
    'builtin',
    'version',
    'source_kind',
    'source_key',
    'created_at',
    'updated_at',
    'archived_at',
  ];

  // The fix lives under its own migration id, not by editing the applied team-runs one.
  assert.notEqual(TEAM_TEMPLATES_MIGRATION.id, TEAM_MIGRATION.id, 'corrective migration uses a new id');

  const create = TEAM_TEMPLATES_MIGRATION.statements.find((s) =>
    /CREATE TABLE IF NOT EXISTS team_templates\b/i.test(s),
  );
  assert.ok(create, 'corrective migration creates team_templates');

  for (const column of REQUIRED_COLUMNS) {
    assert.match(create, new RegExp(`\\b${column}\\b`), `team_templates defines ${column}`);
  }

  // roles_json holds the role array and must be non-null JSON.
  assert.match(create, /roles_json\s+JSON\s+NOT NULL/i);

  // The original broken shape required `definition_json` / `kind`, which the
  // repository never supplies — the corrected table must not reintroduce them.
  assert.ok(!/\bdefinition_json\b/i.test(create), 'no definition_json column');
  assert.ok(!/\bkind\b/i.test(create), 'no standalone kind column');

  // The stale, mismatched table from 20260618_team_runs is dropped before recreation.
  assert.ok(
    TEAM_TEMPLATES_MIGRATION.statements.some((s) => /DROP TABLE IF EXISTS team_templates\b/i.test(s)),
    'drops the stale team_templates before recreating it',
  );
});

test('migrate() applies TEAM_MIGRATION exactly once and a second pass is a no-op (fake pool)', async () => {
  const db = new FakeDb();
  await migrate(db as unknown as Pool);

  // The new migration id is recorded once...
  assert.equal(
    db.migrationsApplied.filter((id) => id === TEAM_MIGRATION.id).length,
    1,
    'TEAM_MIGRATION id recorded exactly once',
  );
  // ...as is the team_templates corrective migration (FINDING-003).
  assert.equal(
    db.migrationsApplied.filter((id) => id === TEAM_TEMPLATES_MIGRATION.id).length,
    1,
    'team_templates corrective migration recorded exactly once',
  );
  // ...and every team table was effectively created exactly once.
  for (const table of TEAM_TABLES) {
    assert.equal(db.effectiveCreates.get(table), 1, `${table} created exactly once`);
  }
  // Existing migrations still ran (their tables exist) — proving we appended, not replaced.
  for (const table of ['app_meta', 'execution_runs', 'tasks', 'findings', 'run_templates']) {
    assert.ok(db.tables.has(table), `existing table ${table} still created`);
  }

  // Second pass: re-issue the team statements. CREATE TABLE IF NOT EXISTS makes them no-ops.
  for (const stmt of TEAM_MIGRATION.statements) await db.query(stmt);
  for (const table of TEAM_TABLES) {
    assert.equal(db.effectiveCreates.get(table), 1, `${table} not recreated on second pass`);
  }

  // The runner's own guard predicate now skips the team migration on a subsequent boot.
  const [guardRows] = await db.query('SELECT id FROM schema_migrations WHERE id = ? LIMIT 1', [TEAM_MIGRATION.id]);
  assert.equal((guardRows as unknown[]).length, 1, 'guard finds the recorded id, so a re-run skips');
});

function assertStrictlyIncreasing(messages: TeamMessageRecord[]): void {
  const seqs = messages.map((m) => m.seq);
  const sorted = [...seqs].sort((a, b) => a - b);
  assert.deepEqual(seqs, sorted, 'messages are sorted by seq');
  assert.equal(new Set(seqs).size, seqs.length, 'seq values are strictly increasing (no duplicates)');
}

/**
 * Minimal in-memory stand-in for a mysql2 Pool, faithful to the subset of behavior
 * the migration runner relies on: a `schema_migrations` guard table, `CREATE TABLE
 * IF NOT EXISTS` semantics, and per-migration transactions. It lets us drive the real
 * `migrate()` without a live database.
 */
class FakeDb {
  readonly tables = new Set<string>();
  readonly effectiveCreates = new Map<string, number>();
  readonly migrationsApplied: string[] = [];

  async query(sql: string, params: unknown[] = []): Promise<[unknown[], unknown[]]> {
    const s = String(sql).trim();
    if (/^CREATE TABLE IF NOT EXISTS/i.test(s)) {
      this.applyCreate(s);
      return [[], []];
    }
    if (/^SELECT id FROM schema_migrations/i.test(s)) {
      const id = params[0] as string;
      return [this.migrationsApplied.includes(id) ? [{ id }] : [], []];
    }
    if (/^INSERT\s+(IGNORE\s+)?INTO schema_migrations/i.test(s)) {
      this.recordMigration(params[0] as string);
      return [[], []];
    }
    return [[], []];
  }

  async getConnection(): Promise<FakeConn> {
    return new FakeConn(this);
  }

  applyCreate(sql: string): void {
    const match = /^CREATE TABLE IF NOT EXISTS\s+`?([A-Za-z0-9_]+)`?/i.exec(sql);
    if (!match) return;
    const name = match[1]!;
    if (!this.tables.has(name)) {
      this.tables.add(name);
      this.effectiveCreates.set(name, (this.effectiveCreates.get(name) ?? 0) + 1);
    }
  }

  recordMigration(id: string): void {
    if (!this.migrationsApplied.includes(id)) this.migrationsApplied.push(id);
  }
}

class FakeConn {
  constructor(private readonly db: FakeDb) {}
  async beginTransaction(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
  release(): void {}

  async query(sql: string, params: unknown[] = []): Promise<[unknown[], unknown[]]> {
    const s = String(sql).trim();
    if (/^CREATE TABLE IF NOT EXISTS/i.test(s)) this.db.applyCreate(s);
    else if (/^INSERT\s+(IGNORE\s+)?INTO schema_migrations/i.test(s)) this.db.recordMigration(params[0] as string);
    return [[], []];
  }
}
