/** Fresh database for the browser suite. Real PostgreSQL when TEST_DATABASE_URL is set, else a new PGlite dir. */
import fs from 'node:fs';
import path from 'node:path';
const dataDir = path.resolve(process.env.DATA_DIR ?? 'data/e2e');
fs.rmSync(path.join(dataDir, 'pglite'), { recursive: true, force: true });
fs.rmSync(path.join(dataDir, 'uploads'), { recursive: true, force: true });
if (process.env.TEST_DATABASE_URL) {
  const pg = (await import('pg')).default;
  const a = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await a.connect();
  await a.query('drop database if exists fragged_e2e with (force)');
  await a.query('create database fragged_e2e');
  await a.end();
}
