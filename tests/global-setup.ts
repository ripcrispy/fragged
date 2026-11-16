/**
 * Test databases.
 * - Default: migrate PGlite once and snapshot it; each file clones the snapshot (embedded Postgres).
 * - TEST_DATABASE_URL set (any database on a real server, used only for admin commands):
 *   migrate a template database once; each test file gets `CREATE DATABASE … TEMPLATE fragged_test_tpl`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export default async function setup() {
  process.env.NODE_ENV = 'test';
  const migDir = path.resolve('drizzle');
  const hash = crypto.createHash('sha256');
  for (const f of fs.readdirSync(migDir).sort()) if (f.endsWith('.sql')) hash.update(fs.readFileSync(path.join(migDir, f)));
  const key = hash.digest('hex').slice(0, 16);
  if (process.env.TEST_DATABASE_URL) {
    const pg = (await import('pg')).default;
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    // remove leftovers from interrupted runs, then rebuild the template
    const old = await admin.query("select datname from pg_database where datname like 'fragged_test_%'");
    for (const r of old.rows) await admin.query(`drop database if exists "${r.datname}" with (force)`);
    await admin.query('create database fragged_test_tpl');
    await admin.end();
    const { createDb } = await import('../src/db/client.ts');
    const h = await createDb({ url: withDb(process.env.TEST_DATABASE_URL, 'fragged_test_tpl') });
    await h.close();
    return async () => {
      const a = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await a.connect();
      const rows = await a.query("select datname from pg_database where datname like 'fragged_test_%'");
      for (const r of rows.rows) await a.query(`drop database if exists "${r.datname}" with (force)`);
      await a.end();
    };
  }
  const dir = path.resolve('data/test');
  fs.mkdirSync(dir, { recursive: true });
  const snap = path.join(dir, `snapshot-${key}.tgz`);
  if (!fs.existsSync(snap)) {
    const { createDb } = await import('../src/db/client.ts');
    const h = await createDb({ memory: true });
    const blob = await ((h.db as any).$client).dumpDataDir('gzip');
    fs.writeFileSync(snap, Buffer.from(await blob.arrayBuffer()));
    await h.close();
  }
  process.env.TEST_DB_SNAPSHOT = snap;
}

export function withDb(url: string, db: string) { const u = new URL(url); u.pathname = '/' + db; return u.toString(); }
