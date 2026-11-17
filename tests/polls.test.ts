/** Polls: creating, voting, result visibility, control by creators and moderators, and privacy. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupDb, teardownDb, makeUser, makeForum, client, viewerFor } from './helpers.ts';
import { getDb, schema } from '../src/db/client.ts';
import { setModuleEnabled } from '../src/modules/runtime.ts';
import { resetLimits } from '../src/lib/ratelimit.ts';
import * as F from '../src/services/forums.ts';
import * as Privacy from '../src/services/privacy.ts';
import { validate, createPoll, vote, pollForThread, optionsFor, results, ballotOf, setClosed, canSeeResults, ballots, type NewPoll } from '../modules/polls/service.ts';

const base: NewPoll = { question: 'Best map?', options: ['Dust', 'Nuke', 'Inferno'], maxChoices: 1, results: 'always', showVoters: false, allowChange: true, closesAt: null };
let n = 0;
async function threadBy(userId: number, title = `Poll thread ${++n}`) {
  resetLimits();
  const forum = await makeForum(`Polls ${n}`);
  return (await F.createThread(await viewerFor(userId), forum, { title, body: 'Vote below!' })).thread;
}

beforeAll(async () => { await setupDb(); await setModuleEnabled('polls', true); });
afterAll(teardownDb);

describe('default permissions', () => {
  it('gives “member” permissions to every signed-in group, and guest ones to guests', async () => {
    const groups = new Map((await getDb().select().from(schema.userGroups)).map((g) => [g.slug, g.permissions as Record<string, boolean>]));
    for (const slug of ['member', 'established', 'contributor', 'moderator']) expect(groups.get(slug)!['polls.vote']).toBe(true);
    expect(groups.get('guest')!['polls.view']).toBe(true);
    expect(groups.get('guest')!['polls.vote']).toBeUndefined();
    expect(groups.get('moderator')!['polls.manage']).toBeUndefined(); // moderators manage polls through mod.threads instead
  });
});

describe('validation', () => {
  it('tidies answers and rejects bad polls', () => {
    expect(validate({ ...base, options: [' Dust ', 'dust', '', 'Nuke'], maxChoices: 9 })).toMatchObject({ options: ['Dust', 'Nuke'], maxChoices: 2 });
    expect(() => validate({ ...base, question: 'Hi' })).toThrow(/at least 3/);
    expect(() => validate({ ...base, options: ['Only one'] })).toThrow(/at least 2/);
    expect(() => validate({ ...base, options: Array.from({ length: 11 }, (_, i) => `o${i}`) })).toThrow(/at most 10/);
    expect(() => validate({ ...base, closesAt: new Date(Date.now() - 1000) })).toThrow(/future/);
  });
});

describe('voting', () => {
  it('counts one ballot per member, lets them change it, and limits multiple choice', async () => {
    const author = await makeUser(), a = await makeUser(), b = await makeUser();
    const t = await threadBy(author.id);
    const p = await createPoll(t.id, author.id, { ...base, maxChoices: 2 });
    const [dust, nuke, inferno] = await optionsFor(p.id);
    await vote(p, a.id, [dust.id, nuke.id]);
    await expect(vote(p, b.id, [dust.id, nuke.id, inferno.id])).rejects.toThrow(/at most 2/);
    await expect(vote(p, b.id, [999999])).rejects.toThrow(/Choose an answer/);
    await vote(p, b.id, [nuke.id]);
    await vote(p, a.id, [inferno.id]); // change
    const r = await results(p);
    expect(r.voters).toBe(2);
    expect(r.perOption.map((o) => o.votes)).toEqual([0, 1, 1]);
    expect(r.perOption.map((o) => o.pct)).toEqual([0, 50, 50]);
    // the same member submitting twice at once still gets one ballot
    const c = await makeUser();
    await Promise.allSettled([vote(p, c.id, [dust.id]), vote(p, c.id, [dust.id])]);
    expect(await getDb().select().from(ballots).where(eq(ballots.userId, c.id))).toHaveLength(1);
  });

  it('respects locked votes and closed polls', async () => {
    const author = await makeUser(), a = await makeUser();
    const p = await createPoll((await threadBy(author.id)).id, author.id, { ...base, allowChange: false });
    const [dust, nuke] = await optionsFor(p.id);
    await vote(p, a.id, [dust.id]);
    await expect(vote(p, a.id, [nuke.id])).rejects.toThrow(/doesn’t allow changing/);
    await setClosed(p, true);
    await expect(vote((await pollForThread(p.threadId))!, (await makeUser()).id, [dust.id])).rejects.toThrow(/closed/);
  });

  it('hides results until voting or closing when asked to', () => {
    const p = { closedAt: null, closesAt: null, results: 'voted' } as any;
    expect(canSeeResults(p, { voted: false, privileged: false })).toBe(false);
    expect(canSeeResults(p, { voted: true, privileged: false })).toBe(true);
    expect(canSeeResults({ ...p, results: 'closed' }, { voted: true, privileged: false })).toBe(false);
    expect(canSeeResults({ ...p, results: 'closed' }, { voted: false, privileged: true })).toBe(true);
    expect(canSeeResults({ ...p, results: 'closed', closedAt: new Date() }, { voted: false, privileged: false })).toBe(true);
  });
});

describe('over HTTP', () => {
  it('lets the thread author add a poll, members vote, and moderators control it', async () => {
    const author = await makeUser({ username: 'PollAuthor' });
    await makeUser({ username: 'PollVoter' });
    await makeUser({ username: 'PollMod', group: 'moderator' });
    await makeUser({ username: 'PollStranger' });
    const t = await threadBy(author.id, 'Which game on Saturday?');

    // only the author (or a moderator) sees the add link and can add a poll
    const stranger = client(); await stranger.login('PollStranger');
    expect((await stranger.get(`/t/${t.id}`)).text).not.toContain('Add a poll to this thread');
    expect((await stranger.get(`/m/polls/new?thread=${t.id}`)).status).toBe(403);

    const a = client(); await a.login('PollAuthor');
    expect((await a.get(`/t/${t.id}-${t.slug}`)).text).toContain('Add a poll to this thread');
    const bad = await a.post('/m/polls/new', { thread: String(t.id), question: 'Game?', options: 'Only one', maxChoices: '1', results: 'always', allowChange: '1' });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('at least 2 different answers');
    expect(bad.text).toContain('Only one'); // the form keeps what was typed
    const ok = await a.post('/m/polls/new', { thread: String(t.id), question: 'Which game?', options: 'Rocket League\nCS2\nMinecraft', maxChoices: '1', results: 'voted', allowChange: '1', showVoters: '1' });
    expect(ok.location).toMatch(new RegExp(`^/t/${t.id}-.*#poll$`));
    const p = (await pollForThread(t.id))!;
    const [rl] = await optionsFor(p.id);

    const voter = client(); await voter.login('PollVoter');
    let page = (await voter.get(`/t/${t.id}-${t.slug}`)).text;
    expect(page).toContain('Which game?');
    expect(page).toContain('Results appear once you’ve voted.');
    await voter.post(`/m/polls/${p.id}/vote`, { option: String(rl.id) });
    page = (await voter.get(`/t/${t.id}-${t.slug}`)).text;
    expect(page).toContain('Your vote');
    expect(page).toMatch(/1 · 100%/);
    expect(page).toContain('PollVoter</a>'); // public voters

    // guests see it but can't vote
    const guest = client();
    expect((await guest.get(`/t/${t.id}-${t.slug}`)).text).toContain('Sign in to vote');
    expect((await guest.post(`/m/polls/${p.id}/vote`, { option: String(rl.id) })).status).toBe(401);

    // strangers can't close it; the forum's moderator can, and it's audited
    await stranger.post(`/m/polls/${p.id}/close`);
    expect((await pollForThread(t.id))!.closedAt).toBeNull();
    const mod = client(); await mod.login('PollMod');
    await mod.post(`/m/polls/${p.id}/close`);
    expect((await pollForThread(t.id))!.closedAt).toBeInstanceOf(Date);
    const audit = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'polls.close'));
    expect(audit).toHaveLength(1);
    // the author can delete their own poll
    await a.post(`/m/polls/${p.id}/delete`);
    expect(await pollForThread(t.id)).toBeNull();
  });
});

describe('privacy', () => {
  it('exports votes and keeps totals when a member erases their data', async () => {
    const author = await makeUser(), member = await makeUser();
    const p = await createPoll((await threadBy(author.id)).id, author.id, base);
    const [dust] = await optionsFor(p.id);
    await vote(p, member.id, [dust.id]);
    const data = await Privacy.exportUserData(member.id);
    expect((data.addOns.polls.data as any).votes[0]).toMatchObject({ poll: 'Best map?', answers: ['Dust'] });
    await Privacy.eraseUserData(member.id, new Set(['modules']), { ip: null });
    expect(await ballotOf(p.id, member.id)).toBeNull();
    expect((await results(p)).perOption[0].votes).toBe(1);
  });
});
