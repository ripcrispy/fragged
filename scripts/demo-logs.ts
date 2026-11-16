/** Development only: fill audit_log / security_events with a varied month of entries for UI testing. */
import { sql } from 'drizzle-orm';
import { config } from '../src/config.ts';
import { createDb, setDb, closeDb, getDb } from '../src/db/client.ts';
import { AUDIT_ACTIONS, SECURITY_KINDS } from '../src/web/log-labels.ts';
if (config.isProd) { console.error('Refusing in production.'); process.exit(1); }
setDb(await createDb());
const db = getDb();
const actions = Object.keys(AUDIT_ACTIONS);
const kinds = Object.keys(SECURITY_KINDS);
const weights = kinds.map((k) => (k === 'login' ? 30 : k === 'login_failed' ? 10 : k === 'logout' ? 8 : 2));
await db.execute(sql`
  insert into audit_log (actor_id, action, target_type, target_id, detail, ip, created_at)
  select (select id from users where username in ('Overseer','Vexa') order by random() + g * 0 limit 1),
         (string_to_array(${actions.join(",")}, ','))[1 + floor(random() * ${actions.length})::int],
         t.tt, case when t.tt = 'user' then (select id from users order by random() + g * 0 limit 1) else 1 + floor(random() * 500)::int end,
         jsonb_build_object('reason', (array['Spam links','Off-topic','Harassment in thread','Requested by member','Cleanup'])[1 + floor(random() * 5)::int]),
         '10.0.0.' || (2 + floor(random() * 5)::int), now() - random() * interval '30 days'
  from generate_series(1, 400) g
  cross join lateral (select (array['user','post','thread','forum','group','report','term'])[1 + floor(random() * 7)::int + g * 0] as tt) t`);
const pool = kinds.flatMap((k, i) => Array(weights[i]).fill(k));
await db.execute(sql`
  insert into security_events (user_id, kind, provider, ip, user_agent, detail, created_at)
  select case when random() < 0.85 then (select id from users order by random() + g * 0 limit 1) end, k.kind,
         case when k.kind in ('login','register','login_failed','oauth_failed','provider_linked','provider_unlinked') then (array['password','password','password','discord','google'])[1 + floor(random() * 5)::int] end,
         '203.0.113.' || (1 + floor(random() * 40)::int),
         (array['Mozilla/5.0 (Windows NT 10.0) Chrome/130','Mozilla/5.0 (Macintosh; Mac OS X) Safari/605','Mozilla/5.0 (Linux; Android 14) Chrome/130','curl/8.5'])[1 + floor(random() * 4)::int],
         case when k.kind = 'login_failed' then jsonb_build_object('login', (array['admin','overseer','test','pixelwren'])[1 + floor(random() * 4)::int]) else '{}'::jsonb end,
         now() - random() * interval '30 days'
  from generate_series(1, 900) g cross join lateral (select (string_to_array(${pool.join(",")}, ','))[1 + floor(random() * ${pool.length})::int + g * 0] as kind) k`);
console.log('demo log entries added');
await closeDb();
