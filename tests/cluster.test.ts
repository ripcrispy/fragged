/** Shared-state primitives used in multi-instance mode. Runs only against a PostgreSQL server (npm run test:pg). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupDb, teardownDb } from './helpers.ts';
import { hit, peek, once, useSharedLimits } from '../src/lib/ratelimit.ts';
import { startBus, stopBus, onBus, send, busActive } from '../src/services/bus.ts';

const real = !!process.env.TEST_DATABASE_URL;

describe.skipIf(!real)('shared state over PostgreSQL', () => {
  beforeAll(async () => { await setupDb(); useSharedLimits(true); });
  afterAll(async () => { useSharedLimits(false); await stopBus(); await teardownDb(); });

  it('rate limits are counted in the database', async () => {
    const key = 'test:' + Math.random();
    const limit = { max: 3, windowSec: 60 };
    for (let i = 0; i < 3; i++) expect((await hit(key, limit)).ok).toBe(true);
    const r = await hit(key, limit);
    expect(r.ok).toBe(false); expect(r.retryAfter).toBeGreaterThan(0);
    expect((await peek('other:' + Math.random(), limit)).ok).toBe(true);
  });

  it('peek does not consume attempts', async () => {
    const key = 'peek:' + Math.random();
    for (let i = 0; i < 10; i++) expect((await peek(key, { max: 2, windowSec: 60 })).ok).toBe(true);
  });

  it('once() de-duplicates', async () => {
    const key = 'view:' + Math.random();
    expect(await once(key, 1800)).toBe(true);
    expect(await once(key, 1800)).toBe(false);
  });

  it('bus messages round-trip through LISTEN/NOTIFY', async () => {
    const { withDb } = await import('./global-setup.ts');
    await startBus(withDb(process.env.TEST_DATABASE_URL!, 'fragged_test_tpl'));
    expect(busActive()).toBe(true);
    const got = new Promise((resolve) => onBus('test_ping', (d) => resolve(d)));
    send('test_ping', { hello: 'cluster' });
    await expect(got).resolves.toEqual({ hello: 'cluster' });
  });
});
