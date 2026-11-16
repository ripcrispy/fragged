/**
 * Development seed: original demo categories, members, threads, friendships, messages and
 * generated emoji/avatars. All content here is written for Fragged.
 *   npm run seed            (refuses to run in production)
 */
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { config } from '../src/config.ts';
import { createDb, setDb, closeDb, getDb, schema } from '../src/db/client.ts';
import { ensureBootstrap } from '../src/db/bootstrap.ts';
import { createUser, getUserByUsername, type User } from '../src/services/users.ts';
import { hashPassword } from '../src/lib/crypto.ts';
import { buildViewer } from '../src/services/viewer.ts';
import { createThread, reply, react, forumBySlug } from '../src/services/forums.ts';
import { sendFriendRequest, respondToRequest, listFriendRequests, setTopFriends } from '../src/services/relationships.ts';
import { openConversation, sendMessage } from '../src/services/messages.ts';
import { saveUpload } from '../src/services/uploads.ts';
import { submitEmoji } from '../src/services/emoji.ts';
import { addComment, setAvatar, updateProfile } from '../src/services/profiles.ts';
import { resetLimits } from '../src/lib/ratelimit.ts';
import { slugify } from '../src/lib/validate.ts';

if (config.isProd) { console.error('Refusing to seed demo content in production.'); process.exit(1); }
setDb(await createDb());
await ensureBootstrap();
const { loadModules, syncModules, isModuleEnabled } = await import('../src/modules/runtime.ts');
await loadModules();
await syncModules();
const db = getDb();
const PASSWORD = process.env.DEMO_PASSWORD ?? process.env.SEED_PASSWORD ?? 'fragged-demo-pass';

const existing = await db.select({ id: schema.categories.id }).from(schema.categories).limit(1);
if (existing.length) { console.log('Database already has categories; skipping demo seed.'); await closeDb(); process.exit(0); }

// ───────── structure ─────────
const STRUCTURE: { name: string; desc: string; forums: { name: string; desc: string; subs?: { name: string; desc: string }[]; notice?: string }[] }[] = [
  { name: 'General Discussion', desc: 'The front room.', forums: [
    { name: 'General Chat', desc: 'Anything that doesn’t fit anywhere else. Keep it friendly.' },
    { name: 'Off-Topic Lounge', desc: 'Food, films, pets, weather, existential dread.' },
    { name: 'News & Current Events', desc: 'Link the source, add your take. Politics stays civil or stays out.', notice: 'Include a source link in the opening post. Opinion threads must be labelled.' },
  ] },
  { name: 'Gaming', desc: 'Playing them.', forums: [
    { name: 'PC Gaming', desc: 'Builds, benchmarks, launchers and everything with a keyboard.' },
    { name: 'Console Corner', desc: 'Handhelds, living-room boxes and couch co-op.' },
    { name: 'Retro & Classics', desc: 'CRTs, cartridges, and games older than some members.' },
    { name: 'LAN & Multiplayer', desc: 'Find teammates, organise matches, share servers.' },
  ] },
  { name: 'Development', desc: 'Making them.', forums: [
    { name: 'Game Development', desc: 'Engines, design, production and post-mortems.', subs: [{ name: 'Level Design', desc: 'Blockouts, flow, lighting and encounter design.' }, { name: 'Game Jams', desc: 'Jam announcements, teams and finished entries.' }] },
    { name: 'Programming', desc: 'Code questions, code reviews, code crimes.' },
    { name: 'Modding & Tools', desc: 'Mods, editors, pipelines and community tools.' },
  ] },
  { name: 'Creative', desc: 'Showing off.', forums: [
    { name: 'Art & Modelling', desc: '2D, 3D, pixel and texture work. Critique welcome.' },
    { name: 'Music & Audio', desc: 'Soundtracks, sound design and things that go boom.' },
    { name: 'Video & Machinima', desc: 'Edits, animations and in-engine films. Share links — videos aren’t uploaded here.' },
  ] },
  { name: 'Community', desc: 'The people.', forums: [
    { name: 'Introductions', desc: 'New here? Say hello.' },
    { name: 'Events & Tournaments', desc: 'Community nights, competitions and results.' },
    { name: 'Site Feedback', desc: 'Bugs, ideas and questions about Fragged itself.' },
  ] },
];
for (const [ci, cat] of STRUCTURE.entries()) {
  const [c] = await db.insert(schema.categories).values({ name: cat.name, slug: slugify(cat.name), description: cat.desc, displayOrder: ci }).returning();
  for (const [fi, f] of cat.forums.entries()) {
    const [forum] = await db.insert(schema.forums).values({ categoryId: c.id, name: f.name, slug: slugify(f.name), description: f.desc, displayOrder: fi, rulesNotice: f.notice ?? '' }).returning();
    for (const [si, s] of (f.subs ?? []).entries()) await db.insert(schema.forums).values({ categoryId: c.id, parentForumId: forum.id, name: s.name, slug: slugify(s.name), description: s.desc, displayOrder: si });
  }
}

// ───────── generated, original artwork ─────────
const PALETTE = ['#e8772e', '#3a8dde', '#5bb974', '#c95de0', '#e0c04a', '#e05a5a', '#4ac9c0', '#8a7cf0'];
async function avatarPng(seed: number, initial: string) {
  const a = PALETTE[seed % PALETTE.length], b = PALETTE[(seed * 3 + 1) % PALETTE.length];
  const shapes = Array.from({ length: 5 }, (_, i) => {
    const x = (seed * 37 + i * 53) % 256, y = (seed * 91 + i * 29) % 256, r = 30 + ((seed + i * 17) % 50);
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${i % 2 ? a : b}" opacity="0.55"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#2b3440"/>${shapes}<text x="128" y="160" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="110" text-anchor="middle" fill="#fff" opacity="0.92">${initial}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
async function emojiPng(svgBody: string) {
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 64 64">${svgBody}</svg>`)).png().toBuffer();
}
async function animated(frames: string[]) {
  const pngs = await Promise.all(frames.map(emojiPng));
  try {
    return await sharp(pngs, { join: { animated: true } } as any).gif({ delay: frames.map(() => 140), loop: 0 } as any).toBuffer();
  } catch { return pngs[0]; }
}

// ───────── members ─────────
const MEMBERS = [
  { username: 'Overseer', group: 'admin', bio: 'Keeps the lights on. Ping me about broken things.', pronouns: 'they/them', location: 'The server room' },
  { username: 'Vexa', group: 'moderator', bio: 'Moderator. Level designer by day, speedrunner by night.', pronouns: 'she/her', location: 'Rotterdam' },
  { username: 'bitcrusher', group: 'established', bio: 'Chiptune enjoyer. I make noises with old sound chips.', location: 'Leeds' },
  { username: 'Lowpoly_Lou', group: 'established', bio: 'Props, environments and the occasional extremely low-poly frog.', pronouns: 'he/him' },
  { username: 'NullSector', group: 'contributor', bio: 'Engine programmer. Ask me about memory allocators (please don’t).' },
  { username: 'quietkeys', group: 'member', bio: 'Mostly lurking. Mechanical keyboards and cosy games.' },
  { username: 'Marrow', group: 'member', bio: 'Horror games and the people who make them.' },
  { username: 'PixelWren', group: 'member', bio: 'Pixel artist. 16 colours is plenty.', pronouns: 'she/they' },
  { username: 'gravwell', group: 'member', bio: 'Physics puzzles and bad puns.' },
];
const users: Record<string, User> = {};
const pw = await hashPassword(PASSWORD);
for (const [i, m] of MEMBERS.entries()) {
  const u = await createUser({ username: m.username, email: `${m.username.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.test`, emailVerified: true, passwordHash: pw, groupSlug: m.group, timezone: 'Europe/London' });
  if (m.group !== 'member') {
    const member = (await db.select().from(schema.userGroups).where(eq(schema.userGroups.slug, 'member')))[0];
    await db.insert(schema.userGroupMemberships).values({ userId: u.id, groupId: member.id }).onConflictDoNothing();
  }
  users[m.username] = u;
  const v = await buildViewer(u, null, '127.0.0.1', 'seed');
  const up = await saveUpload(u.id, 'avatar', await avatarPng(i + 3, m.username[0].toUpperCase()), 'avatar.png');
  await setAvatar(u.id, up.id);
  await updateProfile(v, { bio: m.bio, pronouns: m.pronouns ?? '', location: m.location ?? '' });
}
const V = async (name: string) => buildViewer((await getUserByUsername(name))!, null, '127.0.0.1', 'seed');
await updateProfile(await V('bitcrusher'), { backgroundColor: '#2d4739' });
if (isModuleEnabled('profile-spotify')) {
  const { sql: q } = await import('drizzle-orm');
  await db.execute(q`insert into mod_profile_spotify (user_id, track_url) values (${users.bitcrusher.id}, 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT') on conflict do nothing`);
}
await updateProfile(await V('PixelWren'), { backgroundColor: '#e6d0dc', signature: 'Palette swaps are a lifestyle. :pixelheart:' });

// ───────── emoji (original drawings) ─────────
const EMOJI: [string, string, string, string | string[]][] = [
  ['frag', 'Fragged shard', 'logo diamond', '<path d="M32 4 L58 32 L38 35 Z" fill="#e8772e"/><path d="M58 32 L32 60 L35 40 Z" fill="#b6531a"/><path d="M32 60 L6 32 L26 29 Z" fill="#e8772e"/><path d="M6 32 L32 4 L29 24 Z" fill="#b6531a"/><path d="M29 24 L38 35 L35 40 L26 29 Z" fill="#ffd2b0"/>'],
  ['gg', 'Good game', 'gg well played', '<rect x="4" y="12" width="56" height="40" rx="8" fill="#3a8dde"/><text x="32" y="42" font-family="DejaVu Sans, Arial" font-weight="700" font-size="26" text-anchor="middle" fill="#fff">GG</text>'],
  ['pixelheart', 'Pixel heart', 'love heart pixel', '<g fill="#e05a5a"><rect x="12" y="16" width="12" height="8"/><rect x="40" y="16" width="12" height="8"/><rect x="8" y="24" width="48" height="12"/><rect x="12" y="36" width="40" height="8"/><rect x="20" y="44" width="24" height="6"/><rect x="28" y="50" width="8" height="6"/></g><rect x="14" y="26" width="6" height="6" fill="#fff" opacity=".7"/>'],
  ['lowpoly', 'Low-poly frog', 'frog 3d model', '<path d="M8 44 L20 22 L32 30 L44 22 L56 44 L32 54 Z" fill="#5bb974"/><path d="M20 22 L32 30 L32 54 L8 44 Z" fill="#3f8f57"/><circle cx="21" cy="24" r="6" fill="#fff"/><circle cx="43" cy="24" r="6" fill="#fff"/><circle cx="21" cy="24" r="3" fill="#111"/><circle cx="43" cy="24" r="3" fill="#111"/>'],
  ['pew', 'Pew', 'shoot muzzle flash animated', [
    '<rect x="6" y="28" width="30" height="10" rx="2" fill="#555"/><rect x="10" y="36" width="8" height="12" fill="#444"/>',
    '<rect x="6" y="28" width="30" height="10" rx="2" fill="#555"/><rect x="10" y="36" width="8" height="12" fill="#444"/><path d="M36 26 L50 20 L46 30 L60 33 L46 36 L50 46 L36 40 Z" fill="#e0c04a"/>',
    '<rect x="6" y="28" width="30" height="10" rx="2" fill="#555"/><rect x="10" y="36" width="8" height="12" fill="#444"/><path d="M36 29 L46 26 L44 31 L52 33 L44 35 L46 40 L36 37 Z" fill="#e8772e"/>',
  ]],
  ['wave', 'Wave', 'hello hi animated', [
    '<circle cx="32" cy="34" r="18" fill="#e0c04a"/><rect x="40" y="10" width="8" height="18" rx="4" fill="#e0c04a" transform="rotate(-20 44 28)"/>',
    '<circle cx="32" cy="34" r="18" fill="#e0c04a"/><rect x="40" y="10" width="8" height="18" rx="4" fill="#e0c04a" transform="rotate(15 44 28)"/>',
  ]],
];
const overseer = await V('Overseer');
for (const [code, name, kw, art] of EMOJI) {
  const buf = Array.isArray(art) ? await animated(art) : await emojiPng(art);
  await submitEmoji(overseer, { shortcode: code, name, keywords: kw, file: buf, fileName: `${code}.png` }, { autoApprove: true, category: 'fragged' });
}

// ───────── threads ─────────
resetLimits();
type T = { forum: string; by: string; title: string; body: string; tags?: string[]; replies?: [string, string][]; sticky?: boolean };
const THREADS: T[] = [
  { forum: 'site-feedback', by: 'Overseer', sticky: true, title: 'Welcome to Fragged — start here', tags: ['Meta'], body: `Welcome aboard!\n\nA few things to know:\n[list]\n[*]Read the [url=/rules]Community Rules[/url] — they're short.\n[*]Add friends from their profiles; they show up in the pane on the right and you can message them from there.\n[*]Use the [b]Spoiler[/b], [b]NSFW[/b] and [b]Trigger Warning[/b] labels when starting threads.\n[*]Custom emoji: try :frag: :gg: :wave:\n[/list]\nFound a bug? Reply here or start a thread in this forum.`, replies: [['quietkeys', 'Finally, a forum that loads instantly. :wave:'], ['Vexa', 'Mods are around if you need anything. Report button is under every post.']] },
  { forum: 'introductions', by: 'PixelWren', title: 'Hi! Pixel artist, coffee enthusiast', tags: ['Discussion'], body: 'I mostly draw 32×32 sprites and try to finish one small game a year. Say hi if you’re into pixel art!', replies: [['Lowpoly_Lou', 'Welcome! We should do a 2D vs 3D art trade some time.'], ['bitcrusher', 'Need chiptune for that yearly game? I have opinions about square waves.'], ['PixelWren', '@bitcrusher yes please, my last game used one free sound effect for everything :pixelheart:']] },
  { forum: 'level-design', by: 'Vexa', title: 'Blockout feedback thread — post your greyboxes', tags: ['Feedback', 'WIP'], body: 'Post screenshots of your blockouts (no textures!) and get feedback on flow, sightlines and cover.\n\nGuidelines:\n[list=1]\n[*]Say what the space is for.\n[*]Mark the player start and objective.\n[*]Give feedback on two other blockouts for every one you post.\n[/list]', replies: [['gravwell', 'Is a physics puzzle room allowed or is this combat-only?'], ['Vexa', 'Any genre. Puzzle rooms are great — readability matters even more there.']] },
  { forum: 'programming', by: 'NullSector', title: 'Fixed timestep vs. variable: what are you using?', tags: ['Discussion', 'Question'], body: `I keep seeing beginner projects tie physics to frame rate. Here's the loop I use:\n[code]\nconst STEP = 1 / 60;\nlet acc = 0;\nfunction frame(dt) {\n  acc += Math.min(dt, 0.25);\n  while (acc >= STEP) { simulate(STEP); acc -= STEP; }\n  render(acc / STEP); // interpolate\n}\n[/code]\nAnyone doing something smarter?`, replies: [['gravwell', 'Same, plus I clamp the number of steps per frame so a hitch doesn’t spiral.'], ['NullSector', '[quote=gravwell]clamp the number of steps per frame[/quote]Good call, the 0.25 cap is doing that job here but explicit is better.']] },
  { forum: 'retro-classics', by: 'bitcrusher', title: 'Favourite ending of all time (spoilers obviously)', tags: ['Spoiler', 'Discussion'], body: 'Mine: the one where the narrator turns out to be the final boss. [spoiler=Which game]I’m not naming it here so people can still go in blind — DM me![/spoiler]', replies: [['Marrow', 'The ending where you realise the save screen was a character all along. [spoiler]Still haunts me.[/spoiler]']] },
  { forum: 'video-machinima', by: 'Lowpoly_Lou', title: 'Open movie reference for lighting studies', tags: ['Showcase'], body: 'Great reference for lighting and staging (and it’s Creative Commons):\nhttps://www.youtube.com/watch?v=aqz-KE-bpKQ\nClick to load — nothing contacts YouTube until you do.', replies: [['PixelWren', 'The rim lighting in the forest scenes is so good.']] },
  { forum: 'off-topic-lounge', by: 'Marrow', title: 'Share the scariest thing that happened in your house', tags: ['Trigger Warning'], body: 'Labelled because some of these get dark (mentions of injury). Mine: a door that opens by itself every night at 3am. It was the cat. It is always the cat.', replies: [['quietkeys', 'Our smoke alarm chirping at 4am is the true horror genre.']] },
  { forum: 'pc-gaming', by: 'quietkeys', title: 'Post your desk setups', tags: ['Showcase'], body: 'Cable management optional. Shame encouraged.', replies: [['NullSector', 'Three monitors, one of them is just a terminal showing build logs.'], ['gravwell', 'One laptop on a stack of books. Ergonomics are a myth.']] },
  { forum: 'events-tournaments', by: 'Vexa', title: 'Community game night — Friday 20:00 UTC', tags: ['News'], body: 'We’re playing a few rounds of whatever wins the poll in this thread. Reply with suggestions! Voice optional.', replies: [['bitcrusher', 'Something with a level editor so we can make cursed maps.'], ['Lowpoly_Lou', 'Seconding the level editor idea.']] },
];
for (const t of THREADS) {
  const v = await V(t.by);
  const forum = (await forumBySlug(t.forum))!;
  const { thread, post } = await createThread(v, forum, { title: t.title, body: t.body, tags: t.tags });
  if (t.sticky) await db.update(schema.threads).set({ isSticky: true }).where(eq(schema.threads.id, thread.id));
  let last = post.id;
  for (const [by, body] of t.replies ?? []) { resetLimits(); last = (await reply(await V(by), thread.id, body)).id; }
  resetLimits();
  for (const r of ['agree', 'friendly', 'informative']) { try { await react(await V('quietkeys'), post.id, r); } catch { /* own post */ } }
  try { await react(await V('PixelWren'), last, 'funny'); } catch { /* own post */ }
}

// ───────── friendships, top friends, comments, messages ─────────
const pairs: [string, string][] = [['PixelWren', 'bitcrusher'], ['PixelWren', 'Lowpoly_Lou'], ['Vexa', 'NullSector'], ['quietkeys', 'PixelWren'], ['gravwell', 'NullSector'], ['Marrow', 'bitcrusher'], ['Overseer', 'Vexa']];
for (const [a, b] of pairs) {
  resetLimits();
  await sendFriendRequest(users[a].id, users[b].id);
  const { incoming } = await listFriendRequests(users[b].id);
  await respondToRequest(users[b].id, incoming.find((r) => r.fromUserId === users[a].id)!.id, 'accept');
}
await sendFriendRequest(users.gravwell.id, users.PixelWren.id); // left pending for the demo
await setTopFriends(users.PixelWren.id, 3, [users.bitcrusher.id, users.Lowpoly_Lou.id, users.quietkeys.id]);
await addComment(await V('bitcrusher'), users.PixelWren.id, 'Sent you the square-wave pack :gg:');
await addComment(await V('Lowpoly_Lou'), users.PixelWren.id, 'Art trade still on? I have a frog for you. :lowpoly:');
const pv = await V('PixelWren');
const conv = await openConversation(pv, users.bitcrusher.id);
const msgs: [string, string][] = [['PixelWren', 'hey! loved the chip demo you posted'], ['bitcrusher', 'thanks!! want the project file?'], ['PixelWren', 'yes please. also here is the reference I mentioned https://www.youtube.com/watch?v=aqz-KE-bpKQ'], ['bitcrusher', 'oh nice. here’s the file: https://files.example.org/chiptune-pack-v2.zip']];
for (const [i, [by, body]] of msgs.entries()) { resetLimits(); await sendMessage(await V(by), conv.publicId, { body, nonce: `seed-msg-${i}-xyz` }); }

if (isModuleEnabled('achievements')) {
  const { evaluate } = await import('../modules/achievements/service.ts');
  for (const u of Object.values(users)) await evaluate(u.id);
}
console.log(`Seeded ${MEMBERS.length} members (password: ${PASSWORD}), ${THREADS.length} threads, ${EMOJI.length} emoji.`);
console.log('Admin: Overseer · Moderator: Vexa');
await closeDb();
