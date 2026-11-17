import { database, pg, eq, and, asc, inArray, sql, isNull, ServiceError } from '../../src/sdk/index.ts';

export const polls = pg.pgTable('mod_polls_polls', {
  id: pg.serial('id').primaryKey(),
  threadId: pg.integer('thread_id').notNull(),
  createdBy: pg.integer('created_by'),
  question: pg.varchar('question', { length: 200 }).notNull(),
  maxChoices: pg.integer('max_choices').notNull().default(1),
  results: pg.varchar('results', { length: 10 }).notNull().default('always'),
  showVoters: pg.boolean('show_voters').notNull().default(false),
  allowChange: pg.boolean('allow_change').notNull().default(true),
  closesAt: pg.timestamp('closes_at', { withTimezone: true }),
  closedAt: pg.timestamp('closed_at', { withTimezone: true }),
  createdAt: pg.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const options = pg.pgTable('mod_polls_options', {
  id: pg.serial('id').primaryKey(),
  pollId: pg.integer('poll_id').notNull(),
  label: pg.varchar('label', { length: 120 }).notNull(),
  position: pg.integer('position').notNull().default(0),
});
export const ballots = pg.pgTable('mod_polls_ballots', {
  id: pg.serial('id').primaryKey(),
  pollId: pg.integer('poll_id').notNull(),
  userId: pg.integer('user_id'),
  createdAt: pg.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: pg.timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const choices = pg.pgTable('mod_polls_choices', {
  ballotId: pg.integer('ballot_id').notNull(),
  optionId: pg.integer('option_id').notNull(),
});
export type Poll = typeof polls.$inferSelect;
export type Option = typeof options.$inferSelect;

export const RESULTS = {
  always: 'Always',
  voted: 'After voting',
  closed: 'When the poll closes',
} as const;
export type ResultsMode = keyof typeof RESULTS;
export const LIMITS = { minOptions: 2, maxOptions: 10, question: 200, option: 120 };

const db = () => database.db();

export const isOpen = (p: Poll, now = new Date()) => !p.closedAt && (!p.closesAt || p.closesAt > now);

export async function pollForThread(threadId: number) { return (await db().select().from(polls).where(eq(polls.threadId, threadId)))[0] ?? null; }
export async function pollById(id: number) { return (await db().select().from(polls).where(eq(polls.id, id)))[0] ?? null; }
export async function optionsFor(pollId: number) { return db().select().from(options).where(eq(options.pollId, pollId)).orderBy(asc(options.position), asc(options.id)); }

export interface NewPoll { question: string; options: string[]; maxChoices: number; results: ResultsMode; showVoters: boolean; allowChange: boolean; closesAt: Date | null }

/** Checks and tidies a new poll; throws ServiceError with a message the author can act on. */
export function validate(input: NewPoll, now = new Date()): NewPoll {
  const question = input.question.trim().slice(0, LIMITS.question);
  if (question.length < 3) throw new ServiceError('Ask a question of at least 3 characters.');
  const seen = new Set<string>();
  const opts = input.options.map((o) => o.trim().slice(0, LIMITS.option)).filter((o) => o && !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase()));
  if (opts.length < LIMITS.minOptions) throw new ServiceError(`Give at least ${LIMITS.minOptions} different answers.`);
  if (opts.length > LIMITS.maxOptions) throw new ServiceError(`A poll can have at most ${LIMITS.maxOptions} answers.`);
  const maxChoices = Math.min(Math.max(1, Math.floor(input.maxChoices) || 1), opts.length);
  if (!(input.results in RESULTS)) throw new ServiceError('Choose when to show the results.');
  if (input.closesAt && input.closesAt <= now) throw new ServiceError('The closing time must be in the future.');
  return { ...input, question, options: opts, maxChoices };
}

export async function createPoll(threadId: number, userId: number, raw: NewPoll) {
  const input = validate(raw);
  try {
    return await db().transaction(async (tx) => {
      const [p] = await tx.insert(polls).values({
        threadId, createdBy: userId, question: input.question, maxChoices: input.maxChoices, results: input.results,
        showVoters: input.showVoters, allowChange: input.allowChange, closesAt: input.closesAt,
      }).returning();
      await tx.insert(options).values(input.options.map((label, i) => ({ pollId: p.id, label, position: i })));
      return p;
    });
  } catch (e: any) {
    if (String(e?.cause?.message ?? e?.message).includes('mod_polls_thread_uq')) throw new ServiceError('This thread already has a poll.', 409);
    throw e;
  }
}

export async function ballotOf(pollId: number, userId: number) {
  const [b] = await db().select().from(ballots).where(and(eq(ballots.pollId, pollId), eq(ballots.userId, userId)));
  if (!b) return null;
  return { ...b, optionIds: (await db().select().from(choices).where(eq(choices.ballotId, b.id))).map((c) => c.optionId) };
}

/** Cast or change a vote. The unique ballot index stops double votes even when the form is submitted twice at once. */
export async function vote(p: Poll, userId: number, optionIds: number[]) {
  if (!isOpen(p)) throw new ServiceError('This poll is closed.', 403);
  const valid = new Set((await optionsFor(p.id)).map((o) => o.id));
  const picked = [...new Set(optionIds)].filter((id) => valid.has(id));
  if (!picked.length) throw new ServiceError('Choose an answer first.');
  if (picked.length > p.maxChoices) throw new ServiceError(p.maxChoices === 1 ? 'Choose one answer.' : `Choose at most ${p.maxChoices} answers.`);
  const existing = await ballotOf(p.id, userId);
  if (existing && !p.allowChange) throw new ServiceError('You’ve already voted, and this poll doesn’t allow changing your vote.', 409);
  try {
    await db().transaction(async (tx) => {
      let ballotId = existing?.id;
      if (ballotId) {
        await tx.update(ballots).set({ updatedAt: new Date() }).where(eq(ballots.id, ballotId));
        await tx.delete(choices).where(eq(choices.ballotId, ballotId));
      } else {
        [{ id: ballotId }] = await tx.insert(ballots).values({ pollId: p.id, userId }).returning({ id: ballots.id });
      }
      await tx.insert(choices).values(picked.map((optionId) => ({ ballotId: ballotId!, optionId })));
    });
  } catch (e: any) {
    if (String(e?.cause?.message ?? e?.message).includes('mod_polls_ballot_uq')) throw new ServiceError('Your vote was already counted.', 409);
    throw e;
  }
  return { changed: !!existing };
}

export async function retract(p: Poll, userId: number) {
  if (!isOpen(p)) throw new ServiceError('This poll is closed.', 403);
  if (!p.allowChange) throw new ServiceError('This poll doesn’t allow changing your vote.', 403);
  await db().delete(ballots).where(and(eq(ballots.pollId, p.id), eq(ballots.userId, userId)));
}

export async function setClosed(p: Poll, closed: boolean) {
  await db().update(polls).set(closed ? { closedAt: new Date() } : { closedAt: null, closesAt: p.closesAt && p.closesAt <= new Date() ? null : p.closesAt }).where(eq(polls.id, p.id));
}
export async function deletePoll(p: Poll) { await db().delete(polls).where(eq(polls.id, p.id)); }

export interface Results { voters: number; perOption: { option: Option; votes: number; pct: number; voterIds: number[] }[] }
export async function results(p: Poll, withVoters = false): Promise<Results> {
  const opts = await optionsFor(p.id);
  const [{ n }] = await db().select({ n: sql<number>`count(*)::int` }).from(ballots).where(eq(ballots.pollId, p.id));
  const rows = opts.length ? await db().select({ optionId: choices.optionId, userId: ballots.userId }).from(choices)
    .innerJoin(ballots, eq(ballots.id, choices.ballotId)).where(inArray(choices.optionId, opts.map((o) => o.id))) : [];
  return {
    voters: n,
    perOption: opts.map((option) => {
      const mine = rows.filter((r) => r.optionId === option.id);
      return { option, votes: mine.length, pct: n ? Math.round((mine.length / n) * 100) : 0, voterIds: withVoters ? mine.map((r) => r.userId).filter((x): x is number => x !== null) : [] };
    }),
  };
}

/** Whether results are visible to this viewer right now. Creators and managers always see them. */
export function canSeeResults(p: Poll, opts: { voted: boolean; privileged: boolean }) {
  if (opts.privileged || !isOpen(p)) return true;
  if (p.results === 'always') return true;
  if (p.results === 'voted') return opts.voted;
  return false;
}

// ── privacy ──

export async function exportFor(userId: number) {
  const mine = await db().select({ b: ballots, question: polls.question, threadId: polls.threadId }).from(ballots).innerJoin(polls, eq(polls.id, ballots.pollId)).where(eq(ballots.userId, userId));
  const votes = await Promise.all(mine.map(async ({ b, question, threadId }) => ({
    poll: question, thread: `/t/${threadId}`, voted: b.createdAt, changed: b.updatedAt,
    answers: (await db().select({ label: options.label }).from(choices).innerJoin(options, eq(options.id, choices.optionId)).where(eq(choices.ballotId, b.id))).map((o) => o.label),
  })));
  const created = await db().select().from(polls).where(eq(polls.createdBy, userId));
  return {
    votes,
    pollsCreated: await Promise.all(created.map(async (p) => ({ question: p.question, thread: `/t/${p.threadId}`, created: p.createdAt, answers: (await optionsFor(p.id)).map((o) => o.label) }))),
  };
}

/** Votes stay in the totals but are no longer linked to the member; their polls stay on their threads, unlinked. */
export async function anonymise(userId: number) {
  await db().update(ballots).set({ userId: null }).where(eq(ballots.userId, userId));
  await db().update(polls).set({ createdBy: null }).where(eq(polls.createdBy, userId));
}

export async function openPollCount() {
  const [{ n }] = await db().select({ n: sql<number>`count(*)::int` }).from(polls).where(and(isNull(polls.closedAt), sql`(${polls.closesAt} is null or ${polls.closesAt} > now())`));
  return n;
}
