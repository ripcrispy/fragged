/**
 * Demo content for the LAN-party modules (seating, bookings, intranet, caffeine tracker, pizza, event access). Enables them.
 * Safe to re-run: each part is skipped when its demo data already exists.
 *   npx tsx scripts/demo-lan.ts     (development only; run after `npm run seed`)
 */
import { sql, eq } from 'drizzle-orm';
import { config } from '../src/config.ts';
import { createDb, setDb, closeDb, getDb, schema } from '../src/db/client.ts';
import { ensureBootstrap } from '../src/db/bootstrap.ts';
import { resetLimits } from '../src/lib/ratelimit.ts';

if (config.isProd) { console.error('Refusing to add demo content in production.'); process.exit(1); }
setDb(await createDb());
await ensureBootstrap();
const { loadModules, syncModules, setModuleEnabled, saveModuleSettings } = await import('../src/modules/runtime.ts');
await loadModules(); await syncModules();
for (const id of ['lan-seating', 'caffeine-tracker', 'lan-pizza', 'lan-intranet', 'lan-event-access', 'lan-bookings', 'lan-tournaments']) await setModuleEnabled(id, true); // event access starts in demo mode
const { events, bookings, book } = await import('../modules/lan-seating/service.ts');
const { listDrinks, logDrink } = await import('../modules/caffeine-tracker/service.ts');
const pizza = await import('../modules/lan-pizza/service.ts');
const db = getDb();

const rowsOf = (r: any) => (r.rows ?? r) as unknown[];
const users = await db.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(sql`${schema.users.closedAt} is null`).orderBy(schema.users.id).limit(12);
const now = Date.now(), H = 3600_000;

// pizza run (independent of the rest, so it can be added to an existing demo)
if (!rowsOf(await db.execute(sql`select 1 from mod_lan_pizza_rounds where name = 'Friday night pizza'`)).length) {
  await pizza.seedMenu();
  const [r] = await db.insert(pizza.rounds).values({ name: 'Friday night pizza', status: 'open', closesAt: new Date(Math.ceil((now + 3 * H) / H) * H), notes: 'Ordering from the place on the corner. Food expected about 45 minutes after orders close; collect at the front desk.' }).returning();
  const m = await pizza.listMenu();
  const id = (n: string) => m.find((x) => x.name === n)!.id;
  const picks: [number, [string, number][], string, boolean][] = [
    [0, [['Pepperoni', 1], ['Garlic bread', 1]], '', true], [2, [['Margherita', 1], ['Can of soft drink', 2]], 'no basil please', true],
    [3, [['Meat feast', 2]], 'cut in 8', false], [4, [['Vegan garden', 1], ['Fries', 1]], 'vegan — no dairy at all', true],
    [5, [['BBQ chicken', 1]], '', false], [6, [['Ham & pineapple', 1], ['Bottle of water', 1]], '', false],
  ];
  resetLimits();
  for (const [ui, lines, notes, paid] of picks) {
    if (!users[ui]) continue;
    await pizza.placeOrder(r, users[ui].id, lines.map(([n, q]) => ({ menuId: id(n), qty: q })), notes);
    if (paid) { const o = await pizza.orderOf(r.id, users[ui].id); await pizza.setPaid(o!.id, true, users[0].id); }
  }
  console.log(`Pizza demo: ${picks.length} orders.`);
}

/** Bookings for Frag Night 01, its crew and a sticky announcement thread (skipped when already set up). */
async function demoBookings() {
  const B = await import('../modules/lan-bookings/service.ts');
  const F = await import('../src/services/forums.ts');
  const { buildViewer } = await import('../src/services/viewer.ts');
  const [ev] = await db.select().from(events).where(eq(events.slug, 'frag-night-01'));
  if (!ev || (await B.configFor(ev.id))) return;
  await B.setUp(ev.id);
  const [standard, fast] = await B.typesFor(ev.id);
  await db.update(B.types).set({ seats: 'B' }).where(eq(B.types.id, fast.id)); // row B is on the 10 Gb/s switch
  await db.insert(B.types).values({ eventId: ev.id, name: 'Spectator', description: 'No seat, just here for the tournaments and the pizza.', priceCents: 500, capacity: 15, displayOrder: 30 });
  await db.update(B.configs).set({ status: 'open', intro: 'Two nights of LAN gaming, a 5v5 tournament and far too much pizza.' }).where(eq(B.configs.eventId, ev.id));
  const seatOf = new Map((await db.select().from(bookings).where(eq(bookings.eventId, ev.id))).map((b) => [b.userId, b.seat]));
  // sign-ups spread over the last two weeks so the interest chart has a shape
  const ago = (i: number) => new Date(now - ((i * 5) % 14) * 24 * H - i * H);
  const seated = users.filter((u) => seatOf.has(u.id));
  // the last two seat holders haven't committed yet: they're interested, without a seat
  const undecided = seated.slice(-2);
  for (const u of undecided) await db.delete(bookings).where(eq(bookings.userId, u.id));
  for (const [i, u] of seated.entries()) {
    const seat = seatOf.get(u.id)!;
    const interested = undecided.includes(u);
    await db.insert(B.bookings).values({ eventId: ev.id, userId: u.id, typeId: seat.startsWith('B') || interested ? fast.id : standard.id, status: interested ? 'interested' : 'booked', termsAcceptedAt: interested ? null : new Date(), createdAt: ago(i), updatedAt: ago(i) }).onConflictDoNothing();
  }
  const byName = new Map(users.map((u) => [u.username, u.id]));
  const crew: [string, string, string][] = [['Overseer', 'Admin', ''], ['Vexa', 'Moderator', ''], ['quietkeys', 'LAN admin', 'network and servers'], ['NullSector', 'Volunteer', 'front desk, Friday']];
  for (const [name, role, note] of crew) if (byName.has(name)) await B.addCrew(ev.id, byName.get(name)!, role, note);
  const [admin] = await db.select().from(schema.users).where(eq(schema.users.username, 'Overseer'));
  const forum = await F.forumBySlug('general-chat');
  if (admin && forum) {
    const v = await buildViewer(admin, null, '127.0.0.1', 'demo');
    resetLimits();
    const { thread } = await F.createThread(v, forum, { title: 'Bookings open: Frag Night 01', body: `[b]Frag Night 01[/b] is taking bookings!\n\nTwo nights of LAN gaming at the community hall. Grab a standard seat, a high-speed network seat on the 10 Gb/s row, or come along as a spectator.\n\n[url=/m/lan-bookings/frag-night-01]Book your place[/url]. Not sure yet? Register your interest on the same page.` });
    await F.setThreadFlags(v, thread.id, { isSticky: true });
    await db.update(B.configs).set({ threadId: thread.id }).where(eq(B.configs.eventId, ev.id));
  }
  console.log('Bookings demo: 3 booking types, crew and a sticky announcement thread.');
}

/**
 * Three tournaments at Frag Night 01: a 1v1 bracket in progress (with a live match, a reported score and a
 * scheduled final), a kart free-for-all taking registrations, and a finished 2v2 league with published results.
 */
async function demoTournaments() {
  const T = await import('../modules/lan-tournaments/service.ts');
  const M = await import('../modules/lan-tournaments/matches.ts');
  const S = await import('../modules/lan-tournaments/schema.ts');
  if ((await db.select().from(S.tournaments)).length) return;
  const [ev] = await db.select().from(events).where(eq(events.slug, 'frag-night-01'));
  const [admin] = await db.select().from(schema.users).where(eq(schema.users.username, 'Overseer'));
  if (!ev || !admin) return;
  const at = (h: number) => new Date(ev.startsAt!.getTime() + h * H);
  const blank = { description: '', rules: '', visibility: 'public' as const, teamMin: 1, teamMax: 1, subsMax: 0, maxEntries: null, requireApproval: false, requireCheckin: false, requireBooking: false, lanEventId: ev.id, regOpensAt: null, regClosesAt: null, checkinOpensAt: null, endsAt: null };
  const byName = new Map(users.map((u) => [u.username, u.id]));
  const id = (n: string) => byName.get(n)!;

  // 1. the main event, in progress
  const show = await T.createTournament({ ...blank, name: 'Frag Night Showdown', game: 'Quake Champions', platform: 'PC', mode: 'solo', format: 'single_elim', maxEntries: 8,
    description: 'One-on-one arena shooter, single elimination. Winner takes the golden mouse.', rules: '[list]\n[*]Best of 1, final best of 3.\n[*]Maps: Blood Covenant, Ruins of Sarnath, Awoken.\n[*]Report your score straight after the match.\n[/list]',
    config: { bestOf: 1, finalBestOf: 3, thirdPlace: true, seeding: 'manual', rankingPoints: [100, 70, 50, 35, 20, 20, 20, 20], participationPoints: 10 }, startsAt: at(3), checkinOpensAt: at(2) }, admin.id);
  await T.setStatus(show, 'registration_open');
  const players = ['PixelWren', 'bitcrusher', 'Lowpoly_Lou', 'NullSector', 'quietkeys', 'Marrow', 'gravwell', 'Vexa'];
  for (const [i, n] of players.entries()) { const e = await T.registerSolo((await T.byId(show.id))!, id(n), {}, { bypass: true }); await T.setSeedsAndStations(show, [{ entryId: e.id, seed: i + 1, station: `Stage PC ${(i % 4) + 1}` }]); await T.checkIn((await T.byId(show.id))!, e, { byStaff: true }); }
  await T.setStaff(show, id('Vexa'), 'referee');
  await M.generateBracket((await T.byId(show.id))!);
  let t1 = (await T.byId(show.id))!;
  const ms = () => M.matchesOf(show.id);
  for (const m of (await ms()).filter((x) => x.round === 1)) await M.overrideResult(t1, m, m.code === 'R1-3' ? { scoreA: 13, scoreB: 15 } : { scoreA: 15, scoreB: 9 + m.position });
  t1 = (await T.byId(show.id))!;
  const [sf1, sf2] = (await ms()).filter((x) => x.round === 2);
  await M.setLive(sf1, true);
  const ent = new Map((await T.entriesOf(show.id)).map((e) => [e.id, e]));
  await M.reportScore(t1, sf2, { userId: ent.get(sf2.entryA!)!.userId!, side: 'a' }, { scoreA: 15, scoreB: 11 });
  const final = (await ms()).find((x) => x.code === 'R3-1')!;
  await M.scheduleMatch(t1, final, at(5), 'Stage PC 1');
  await M.scheduleMatch(t1, (await ms()).find((x) => x.code === '3RD')!, at(4.5), 'Stage PC 2');
  await T.announce(t1, 'Semi-finals are on! Grab a seat by the stage screen. The final is best of 3.', admin.id);

  // 2. kart cup, taking registrations
  const kart = await T.createTournament({ ...blank, name: 'Kart Cup', game: 'Mario Kart 8 Deluxe', platform: 'Switch', mode: 'solo', format: 'ffa', maxEntries: 16,
    description: 'Three rounds of 4-player races. Points for every placing; most points wins.', config: { ffaRounds: 3, heatSize: 4, ffaPoints: [15, 10, 6, 3] }, startsAt: at(20), regClosesAt: at(19) }, admin.id);
  await T.setStatus(kart, 'registration_open');
  for (const n of ['PixelWren', 'gravwell', 'Marrow', 'quietkeys', 'bitcrusher']) await T.registerSolo((await T.byId(kart.id))!, id(n), {}, { bypass: true });

  // 3. last month's doubles league, finished
  const dbl = await T.createTournament({ ...blank, lanEventId: null, name: 'Spring Doubles', game: 'Rocket League', platform: 'PC', mode: 'team', teamMin: 2, teamMax: 2, format: 'round_robin',
    description: '2v2 league from the spring LAN.', config: { bestOf: 1, allowDraws: false, rankingPoints: [80, 50, 30, 15], participationPoints: 5 }, startsAt: new Date(now - 30 * 24 * H) }, admin.id);
  await T.setStatus(dbl, 'registration_open');
  const pairs: [string, string, string][] = [['Team Boost', 'PixelWren', 'bitcrusher'], ['Aerial Aces', 'Lowpoly_Lou', 'NullSector'], ['Ceiling Shots', 'quietkeys', 'Marrow'], ['Demo Kings', 'gravwell', 'Vexa']];
  for (const [name, a, b] of pairs) {
    let d = (await T.byId(dbl.id))!;
    const team = await T.createTeam(d, id(a), name, name.split(' ').map((w) => w[0]).join(''));
    await T.inviteToTeam(d, team, id(b), 'player'); await T.answerInvite(d, team, id(b), true);
    d = (await T.byId(dbl.id))!;
    await T.registerTeam(d, team, {}, { bypass: true });
  }
  await M.generateBracket((await T.byId(dbl.id))!);
  for (const m of await M.matchesOf(dbl.id)) await M.overrideResult((await T.byId(dbl.id))!, m, m.entryA! < m.entryB! ? { scoreA: 3 + (m.round % 2), scoreB: 1 } : { scoreA: 2, scoreB: 4 });
  await M.publishResults((await T.byId(dbl.id))!, admin.id);
  await db.update(S.tournaments).set({ resultsPublishedAt: new Date(now - 29 * 24 * H) }).where(eq(S.tournaments.id, dbl.id));
  console.log('Tournament demo: a bracket in progress, a kart cup taking entries and a finished doubles league.');
}

/** A poll on the announcement thread: which game for the tournament (skipped when it already has one). */
async function demoPoll() {
  const B = await import('../modules/lan-bookings/service.ts');
  const Polls = await import('../modules/polls/service.ts');
  const [ev] = await db.select().from(events).where(eq(events.slug, 'frag-night-01'));
  const conf = ev ? await B.configFor(ev.id) : null;
  if (!conf?.threadId || (await Polls.pollForThread(conf.threadId))) return;
  const [admin] = await db.select().from(schema.users).where(eq(schema.users.username, 'Overseer'));
  const poll = await Polls.createPoll(conf.threadId, admin.id, {
    question: 'Which game should the 5v5 tournament be?', options: ['Counter-Strike 2', 'Valorant', 'Rocket League (3v3, sorry)', 'Team Fortress 2'],
    maxChoices: 1, results: 'always', showVoters: false, allowChange: true, closesAt: new Date(now + 36 * H),
  });
  const opts = await Polls.optionsFor(poll.id);
  const picks = [0, 0, 2, 0, 1, 2, 3];
  for (const [i, u] of users.slice(0, picks.length).entries()) await Polls.vote(poll, u.id, [opts[picks[i]].id]).catch(() => {});
  console.log('Poll demo: tournament game vote.');
}

const exists = await db.execute(sql`select 1 from mod_lan_seating_events where slug = 'frag-night-01'`);
if (rowsOf(exists).length) { await demoBookings(); await demoPoll(); await demoTournaments(); console.log('LAN demo content already present.'); await closeDb(); process.exit(0); }
const start = new Date(Math.ceil((now + 2 * 24 * H) / H) * H);
const iso = (d: Date) => d.toISOString().slice(0, 16);

// seating
const layout = `################\nSSSS..SSSS..SSSS\nSSSS..SSSS..SSSS\n................\nSSSS..SSSS..SSSS\nVVVV..SSSS..XXSS\n................\n####..####..####`;
const [e] = await db.insert(events).values({ slug: 'frag-night-01', name: 'Frag Night 01', location: 'Community hall, main room', layout, status: 'open', startsAt: start, endsAt: new Date(start.getTime() + 36 * H), notes: 'Bring your own rig, power strip and headphones. Tables are 1.2 m per seat.' }).returning();
const codes = ['B1', 'B2', 'B6', 'B7', 'C3', 'C12', 'E5', 'E6', 'F7'];
for (const [i, u] of users.slice(0, codes.length).entries()) await book(e, u.id, codes[i]).catch(() => {});

// intranet
await saveModuleSettings('lan-intranet', {
  title: 'Frag Night HQ', tagline: 'Plug in, grab a seat, check the servers.', eventStart: iso(start), timezone: 'UTC',
  wifi: '[b]Network:[/b] FRAG-LAN\n[b]Password:[/b] ask at the front desk\nWired is faster — every table has a switch port.',
  info: '[list]\n[*]No cheats, no exceptions.\n[*]Keep walkways clear of cables.\n[*]Quiet hours in the sleeping room from 02:00.\n[*]Lost something? Front desk.\n[/list]',
  sections: 'announcements,countdown,servers,tournaments,schedule,seating,pizza,caffeine,wifi,info', audience: 'everyone', refreshSeconds: 30,
});
await db.execute(sql`insert into mod_lan_intranet_announcements (title, body, level, pinned) values
  ('Doors open Friday at 18:00', 'Check in at the front desk to get your wristband and table number.', 'info', true),
  ('Pizza order closes at 20:00', 'Add your order to the sheet by the door. Vegan options available.', 'warn', false)`);
await db.execute(sql`insert into mod_lan_intranet_servers (name, game, host, port, kind, connect, notes, display_order) values
  ('Forum (this site)', 'Web', '127.0.0.1', ${Number(process.env.PORT ?? 3000)}, 'tcp', '', 'Example TCP check', 10),
  ('Arena shooter #1', 'Source-engine shooter', '127.0.0.1', 27015, 'source', 'connect 10.0.0.20:27015', '5v5, map vote every round', 20),
  ('Block world', 'Minecraft', '127.0.0.1', 25565, 'minecraft', 'mc.lan:25565', 'Creative build-off on Saturday', 30)`);
await db.execute(sql`insert into mod_lan_intranet_schedule (title, starts_at, ends_at, location) values
  ('Doors open & setup', ${start}, ${new Date(start.getTime() + 2 * H)}, 'Main room'),
  ('5v5 tournament — group stage', ${new Date(start.getTime() + 3 * H)}, ${new Date(start.getTime() + 6 * H)}, 'Stage screen'),
  ('Midnight snack run', ${new Date(start.getTime() + 6 * H)}, null, 'Kitchen'),
  ('Finals & prize-giving', ${new Date(start.getTime() + 24 * H)}, ${new Date(start.getTime() + 26 * H)}, 'Stage screen')`);

// caffeine
const drinks = await listDrinks();
const pick = (name: string) => drinks.find((d) => d.name === name)!.id;
const plan: [number, string, number, number][] = [
  [0, 'Monster Energy', 2, 60], [0, 'Espresso (double shot)', 2, 20], [0, 'Bang Energy', 1, 180],
  [1, 'Brewed coffee (big mug)', 1, 90], [1, 'Club-Mate', 1, 30],
  [2, 'Red Bull', 2, 45], [2, 'Cold brew', 1, 240],
  [3, 'Green tea', 1, 60], [4, 'Coca-Cola (can)', 2, 120], [5, 'Caffeine tablet (200 mg)', 1, 300], [5, 'Celsius', 1, 30],
];
resetLimits();
for (const [ui, drink, servings, ago] of plan) if (users[ui]) await logDrink(users[ui].id, { drinkId: pick(drink), servings, minutesAgo: ago });
await demoBookings();
await demoPoll();
await demoTournaments();
const seatsTaken = (await db.select().from(bookings).where(eq(bookings.eventId, e.id))).length;
console.log(`LAN demo ready: ${seatsTaken} seats booked, ${plan.length} drinks logged for ${users.length} members.`);
await closeDb();
