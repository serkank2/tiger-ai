import mysql, { type Connection, type Pool, type PoolConnection, type QueryResult } from 'mysql2/promise';
import { config } from '../config.js';

let pool: Pool | null = null;
let databaseReady: Promise<void> | null = null;

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDatabaseExists(): Promise<void> {
  if (databaseReady) return databaseReady;
  databaseReady = (async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= config.db.connectRetries; attempt += 1) {
      let conn: Connection | null = null;
      try {
        conn = await mysql.createConnection({
          host: config.db.host,
          port: config.db.port,
          user: config.db.user,
          password: config.db.password,
          charset: config.db.charset,
          timezone: 'Z',
        });
        await conn.query(
          `CREATE DATABASE IF NOT EXISTS ${quoteIdent(config.db.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        );
        return;
      } catch (err) {
        lastErr = err;
        const ms = Math.min(config.db.connectRetryDelayMs * 2 ** attempt, config.db.connectMaxDelayMs);
        if (attempt < config.db.connectRetries) await delay(ms);
      } finally {
        await conn?.end().catch(() => {});
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  })();
  return databaseReady;
}

export async function getDbPool(): Promise<Pool> {
  await ensureDatabaseExists();
  pool ??= mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    charset: config.db.charset,
    timezone: 'Z',
    connectionLimit: config.db.connectionLimit,
    waitForConnections: true,
  });
  return pool;
}

export async function closeDbPool(): Promise<void> {
  await pool?.end();
  pool = null;
  databaseReady = null;
}

export async function initDb(): Promise<void> {
  await getDbPool();
}

export async function pingDb(): Promise<boolean> {
  try {
    const db = await getDbPool();
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  await closeDbPool();
}

export async function query<T extends QueryResult>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T> {
  const db = await getDbPool();
  const [result] = await db.query<T>(sql, params as unknown[]);
  return result;
}

export async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const db = await getDbPool();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}
