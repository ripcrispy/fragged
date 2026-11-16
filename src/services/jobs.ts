/** Minimal durable background job queue (PostgreSQL table + in-process poller). */
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { log } from '../lib/log.ts';

type Handler = (payload: any) => Promise<void>;
const handlers = new Map<string, Handler>();
export function registerJob(kind: string, fn: Handler) { handlers.set(kind, fn); }

export async function enqueue(kind: string, payload: Record<string, unknown>, delaySec = 0) {
  await getDb().insert(schema.jobs).values({ kind, payload, runAt: new Date(Date.now() + delaySec * 1000) });
  if (!timer) setImmediate(() => void runDueJobs());
}

let running = false;
export async function runDueJobs(limit = 20): Promise<number> {
  if (running) return 0;
  running = true;
  let n = 0;
  try {
    const db = getDb();
    const due = await db.select().from(schema.jobs)
      .where(and(isNull(schema.jobs.doneAt), lte(schema.jobs.runAt, new Date()), sql`${schema.jobs.attempts} < 5`))
      .orderBy(schema.jobs.runAt).limit(limit);
    for (const job of due) {
      const h = handlers.get(job.kind);
      try {
        if (!h) throw new Error(`No handler for ${job.kind}`);
        await h(job.payload);
        await db.update(schema.jobs).set({ doneAt: new Date(), attempts: job.attempts + 1 }).where(eq(schema.jobs.id, job.id));
        n++;
      } catch (e) {
        const backoff = 30 * 2 ** job.attempts;
        await db.update(schema.jobs).set({ attempts: job.attempts + 1, lastError: String(e).slice(0, 500), runAt: new Date(Date.now() + backoff * 1000) }).where(eq(schema.jobs.id, job.id));
        log.warn('job failed', { kind: job.kind, id: job.id, error: String(e) });
      }
    }
  } finally { running = false; }
  return n;
}

let timer: NodeJS.Timeout | null = null;
export function startJobRunner(intervalMs = 5000) {
  if (timer) return;
  timer = setInterval(() => { void runDueJobs().catch((e) => log.error('job runner', { error: String(e) })); }, intervalMs);
  timer.unref();
}
export function stopJobRunner() { if (timer) clearInterval(timer); timer = null; }
