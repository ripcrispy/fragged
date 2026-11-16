import { serve } from '@hono/node-server';
import { config } from './config.ts';
import { createDb, setDb, closeDb } from './db/client.ts';
import { ensureBootstrap } from './db/bootstrap.ts';
import { createApp } from './app.tsx';
import { startJobRunner, stopJobRunner } from './services/jobs.ts';
import { log } from './lib/log.ts';
import { startBus, stopBus, INSTANCE_ID } from './services/bus.ts';
import { useSharedLimits } from './lib/ratelimit.ts';
import { loadModules, syncModules, startModules, stopModules, listModules, isModuleEnabled } from './modules/runtime.ts';

async function main() {
  const handle = await createDb();
  setDb(handle);
  await ensureBootstrap();
  await loadModules();
  await syncModules();
  if (config.DATABASE_URL) {
    // multi-instance mode: real-time events, presence, cache invalidation and rate limits are shared via PostgreSQL
    await startBus(config.DATABASE_URL);
    useSharedLimits(true);
  }
  const app = createApp();
  await startModules();
  log.info('modules', { enabled: listModules().filter((m) => isModuleEnabled(m.def.id)).map((m) => `${m.def.id}@${m.def.version}`), unavailable: listModules().filter((m) => !m.available).map((m) => `${m.def.id}: ${m.problem}`) });
  startJobRunner();
  const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
    log.info('Fragged Forums listening', { url: config.APP_URL, port: info.port, db: config.DATABASE_URL ? 'postgresql' : `pglite:${config.PGLITE_DIR}`, instance: INSTANCE_ID, shared: !!config.DATABASE_URL });
  });
  const shutdown = async (sig: string) => {
    log.info('shutting down', { sig });
    stopJobRunner();
    server.close();
    await stopModules();
    await stopBus();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => { console.error(e); process.exit(1); });
