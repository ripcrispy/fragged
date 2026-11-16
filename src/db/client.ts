import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import * as schema from './schema.ts';
import { config } from '../config.ts';

export type DB = PgDatabase<any, typeof schema>;
export { schema };

const here = path.dirname(fileURLToPath(import.meta.url));
/** Migrations live in ./drizzle (resolved from the working directory, or MIGRATIONS_DIR). */
export const migrationsFolder = process.env.MIGRATIONS_DIR ? path.resolve(process.env.MIGRATIONS_DIR) : fs.existsSync(path.resolve('drizzle')) ? path.resolve('drizzle') : path.resolve(here, '../../drizzle');

let current: { db: DB; close: () => Promise<void> } | null = null;

/** Create a database handle. `memory: true` gives an isolated in-memory PGlite (tests). */
export async function createDb(opts: { memory?: boolean; url?: string } = {}): Promise<{ db: DB; close: () => Promise<void> }> {
  const url = opts.memory ? undefined : (opts.url ?? config.DATABASE_URL);
  if (url) {
    const pg = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const pool = new pg.default.Pool({ connectionString: url, max: 10 });
    const db = drizzle(pool, { schema }) as unknown as DB;
    await migrate(db as any, { migrationsFolder });
    return { db, close: () => pool.end() };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  let client;
  if (opts.memory) client = new PGlite();
  else {
    const dir = path.resolve(config.PGLITE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    client = new PGlite(dir);
  }
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as any, { migrationsFolder });
  return { db, close: () => client.close() };
}

/** Process-wide database (set by server bootstrap or tests). */
export function setDb(handle: { db: DB; close: () => Promise<void> }) { current = handle; }
export function getDb(): DB {
  if (!current) throw new Error('Database not initialised');
  return current.db;
}
export async function closeDb() { await current?.close(); current = null; }
