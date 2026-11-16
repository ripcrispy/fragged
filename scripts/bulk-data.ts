/**
 * Load-testing dataset (development only). Run after `npm run seed` against a scratch database:
 *   DATABASE_URL=postgres://…/fragged_perf node --import tsx scripts/bulk-data.ts [users] [threads] [postsPerThread]
 * Generates members, threads, posts, friendships and DMs with set-based SQL, then recomputes counters.
 */
import { sql } from 'drizzle-orm';
import { config } from '../src/config.ts';
import { createDb, setDb, closeDb, getDb } from '../src/db/client.ts';

if (config.isProd) { console.error('Refusing to generate bulk data in production.'); process.exit(1); }
const [users = 2000, threads = 20000, ppt = 8] = process.argv.slice(2).map(Number);
setDb(await createDb());
const db = getDb();
const t0 = Date.now();
const step = async (label: string, q: ReturnType<typeof sql>) => { const t = Date.now(); await db.execute(q); console.log(`${label}: ${((Date.now() - t) / 1000).toFixed(1)}s`); };

const memberGroup = sql`(select id from user_groups where slug = 'member')`;
const pw = sql`(select password_hash from users where username = 'quietkeys')`;
await step('users', sql`
  insert into users (username, username_lower, email, email_lower, email_verified_at, password_hash, primary_group_id, timezone, created_at, terms_accepted_at)
  select 'load_user_' || g, 'load_user_' || g, 'load' || g || '@example.test', 'load' || g || '@example.test', now(), ${pw}, ${memberGroup}, 'UTC',
         now() - (random() * interval '900 days'), now()
  from generate_series(1, ${users}) g`);
await step('profiles/settings/groups', sql`
  with u as (select id from users where username like 'load_user_%')
  , p as (insert into user_profiles (user_id, bio) select id, 'Generated member' from u)
  , s as (insert into user_settings (user_id) select id from u)
  insert into user_group_memberships (user_id, group_id) select id, ${memberGroup} from u`);
await step('threads', sql`
  insert into threads (forum_id, user_id, title, slug, created_at, last_post_at, last_position)
  select f.id, u.id, 'Generated thread ' || g || ' about ' || (array['level design','shaders','retro consoles','netcode','pixel art','audio mixing','mods','speedruns'])[1 + g % 8],
         'generated-thread-' || g, ts, ts, 0
  from generate_series(1, ${threads}) g
  cross join lateral (select now() - (random() * interval '800 days') as ts) t
  join lateral (select id from forums order by random() + g * 0 limit 1) f on true
  join lateral (select id from users where username like 'load_user_%' order by random() + g * 0 limit 1) u on true`);
await step('posts', sql`
  insert into posts (thread_id, user_id, position, body, created_at)
  select t.id, case when n = 1 then t.user_id else (select id from users where username like 'load_user_%' offset floor(random() * ${users})::int + (t.id * 0) limit 1) end,
         n, 'Generated post ' || n || ' in thread ' || t.id || '. Talking about [b]' || (array['lighting','collision','frame pacing','palettes','reverb','loot tables'])[1 + (t.id + n) % 6] || '[/b] and some more words for search.',
         t.created_at + (n * interval '37 minutes')
  from threads t cross join lateral generate_series(1, 1 + floor(random() * ${ppt * 2})::int) n
  where t.slug like 'generated-thread-%'`);
await step('thread counters', sql`
  update threads t set reply_count = s.n - 1, last_position = s.maxpos, first_post_id = s.firstid, last_post_id = s.lastid, last_post_at = s.lastat, last_post_user_id = s.lastuser
  from (select thread_id, count(*) n, max(position) maxpos, min(id) firstid, max(id) lastid, max(created_at) lastat,
               (array_agg(user_id order by position desc))[1] lastuser from posts group by thread_id) s
  where s.thread_id = t.id`);
await step('forum counters', sql`
  update forums f set thread_count = s.tc, post_count = s.pc, last_thread_id = s.lt, last_post_at = s.la, last_post_user_id = s.lu
  from (select forum_id, count(*) tc, sum(reply_count + 1) pc, (array_agg(id order by last_post_at desc))[1] lt, max(last_post_at) la,
               (array_agg(last_post_user_id order by last_post_at desc))[1] lu from threads where not is_deleted group by forum_id) s
  where s.forum_id = f.id`);
await step('user counters', sql`
  update users u set post_count = s.n from (select user_id, count(*) n from posts group by user_id) s where s.user_id = u.id`);
await step('friendships', sql`
  insert into friendships (user_low_id, user_high_id)
  select distinct least(a, b), greatest(a, b) from (
    select u.id a, (select id from users where username like 'load_user_%' offset floor(random() * ${users})::int + (u.id * 0) limit 1) b
    from users u cross join generate_series(1, 10) where u.username like 'load_user_%') x where a <> b
  on conflict do nothing`);
await step('conversations + messages', sql`
  with c as (
    insert into conversations (public_id, user_low_id, user_high_id, created_at)
    select substr(md5(random()::text || user_low_id || '-' || user_high_id), 1, 16), user_low_id, user_high_id, now() from friendships
    where random() < 0.3 on conflict do nothing returning id, user_low_id, user_high_id)
  , p as (insert into conversation_participants (conversation_id, user_id) select id, user_low_id from c union all select id, user_high_id from c)
  insert into direct_messages (conversation_id, sender_id, body, client_nonce, created_at)
  select c.id, case when n % 2 = 0 then c.user_low_id else c.user_high_id end, 'generated message ' || n, md5(random()::text), now() - ((40 - n) * interval '3 minutes')
  from c cross join generate_series(1, 20) n`);
await step('conversation pointers', sql`
  update conversations c set last_message_id = s.mid, last_message_at = s.mat from (select conversation_id, max(id) mid, max(created_at) mat from direct_messages group by conversation_id) s where s.conversation_id = c.id`);
await step('analyze', sql`analyze`);
const counts = await db.execute(sql`select (select count(*) from users) users, (select count(*) from threads) threads, (select count(*) from posts) posts, (select count(*) from friendships) friendships, (select count(*) from direct_messages) dms`);
console.log((counts as any).rows[0], `total ${((Date.now() - t0) / 1000).toFixed(0)}s`);
await closeDb();
