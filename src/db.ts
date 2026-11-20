import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg, { type PoolClient } from 'pg';

export function createPool(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is required');
  return new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000 });
}

export async function transaction<T>(pool: pg.Pool | PoolClient, run: (client: PoolClient) => Promise<T>) {
  if ('release' in pool) return run(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function migrate(pool: pg.Pool) {
  const dir = resolve('migrations');
  const files = (await readdir(dir)).filter(file => /^\d+_.+\.sql$/.test(file)).sort();
  await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(4071189)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = await client.query<{name: string}>('SELECT name FROM schema_migrations');
    const names = new Set(applied.rows.map(row => row.name));
    for (const file of files) {
      if (names.has(file)) continue;
      await client.query(await readFile(resolve(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    }
  });
}
