/** @jsxImportSource hono/jsx */
import {
  defineModule, Box, Csrf, Notice, ActionButton, Field, TextArea, Select, Checkbox, Time, UserLink,
  form, str, int, bool, arr, setFlash, cleanLine, parseLocalDateTime, services, ServiceError,
  type ModuleContext, type RequestContext, type PageCtx, type Viewer,
} from '../../src/sdk/index.ts';
import {
  RESULTS, LIMITS, isOpen, pollForThread, pollById, createPoll, ballotOf, vote, retract, setClosed, deletePoll, results, canSeeResults,
  exportFor, anonymise, type Poll, type ResultsMode,
} from './service.ts';

const tzOf = (page: PageCtx) => page.viewer.user?.timezone ?? 'UTC';
/** Bar widths snap to 5% steps so they can be CSS classes (the CSP forbids inline styles). */
const step5 = (pct: number) => Math.max(0, Math.min(100, Math.round(pct / 5) * 5));
type ThreadInfo = NonNullable<Awaited<ReturnType<typeof services.forums.thread>>>;

export default defineModule({
  id: 'polls',
  name: 'Polls',
  version: '1.0.0',
  description: 'Add a poll to a forum thread: single or multiple choice, an optional closing time, results shown always, after voting or when the poll closes, and optionally who voted for what.',
  author: 'Fragged Forums contributors',
  license: 'AGPL-3.0-or-later',
  sdk: '^1.3.0',
  migrations: 'migrations',
  assets: 'public',
  styles: ['polls.css'],
  permissions: {
    view: { label: 'See polls and their results', grantTo: ['guest', 'member'] },
    vote: { label: 'Vote in polls', grantTo: ['member'] },
    create: { label: 'Add a poll to your own threads', grantTo: ['member'] },
    manage: { label: 'Close, reopen and delete any poll (forum moderators can also do this in their forums)' },
  },

  setup(ctx: ModuleContext) {
    const P = { view: ctx.perm('view'), vote: ctx.perm('vote'), create: ctx.perm('create'), manage: ctx.perm('manage') };

    /** Site-wide poll managers, and moderators of the thread's forum. */
    const isModerator = async (v: Viewer, t: ThreadInfo) => !!v.user && ((await v.can(P.manage)) || (await v.can('mod.threads', t.forumId)));
    const canControl = async (v: Viewer, t: ThreadInfo, p: Poll) => !!v.user && (p.createdBy === v.user.id || (await isModerator(v, t)));
    const canAdd = async (v: Viewer, t: ThreadInfo) => !!v.user && !t.isLocked && ((t.userId === v.user.id && (await v.can(P.create))) || (await isModerator(v, t)));
    const pollUrl = (t: ThreadInfo) => `${t.url}#poll`;

    ctx.register.personalData({ id: 'polls', label: 'Polls', export: exportFor, erase: anonymise });

    // ── the poll at the top of its thread ──
    ctx.register.threadPanel({
      id: 'polls', order: 20,
      async render({ viewer: v, thread, ctx: page }) {
        if (!(await v.can(P.view))) return null;
        const t = await services.forums.thread(v, thread.id);
        if (!t) return null;
        const p = await pollForThread(t.id);
        if (!p) {
          return (await canAdd(v, t)) ? <p class="poll-add"><a class="btn btn-small" href={`/m/polls/new?thread=${t.id}`}>Add a poll to this thread</a></p> : null;
        }
        const open = isOpen(p);
        const mine = v.user ? await ballotOf(p.id, v.user.id) : null;
        const control = await canControl(v, t, p);
        const showResults = canSeeResults(p, { voted: !!mine, privileged: control });
        const r = await results(p, p.showVoters && showResults);
        const voterCards = p.showVoters ? await services.users.cards(r.perOption.flatMap((o) => o.voterIds)) : new Map();
        const canVote = open && !!v.user && (await v.can(P.vote));
        const multiple = p.maxChoices > 1;
        const VoteForm = () => (
          <form method="post" action={`/m/polls/${p.id}/vote`} class="poll-form"><Csrf ctx={page} />
            <fieldset class="poll-options"><legend class="sr-only">{p.question}</legend>
              {r.perOption.map(({ option }) => <label class="poll-option"><input type={multiple ? 'checkbox' : 'radio'} name="option" value={String(option.id)} checked={mine?.optionIds.includes(option.id)} required={!multiple} /> {option.label}</label>)}
            </fieldset>
            <div class="form-actions"><button class="btn btn-primary btn-small">{mine ? 'Change my vote' : 'Vote'}</button></div>
          </form>
        );
        const Results = () => (
            <ol class="poll-results">{r.perOption.map(({ option, votes, pct, voterIds }) => (
              <li class={mine?.optionIds.includes(option.id) ? 'is-mine' : ''}>
                <div class="poll-result-head"><span>{option.label}{mine?.optionIds.includes(option.id) ? <span class="tag tag-ok poll-yours">Your vote</span> : null}</span><span class="poll-count">{votes} · {pct}%</span></div>
                <span class="poll-bar" aria-hidden="true"><span class={`poll-fill poll-w-${step5(pct)}`} /></span>
                {voterIds.length ? <div class="small poll-voters">{voterIds.map((id, i) => <>{i ? ', ' : ''}<UserLink user={voterCards.get(id)} /></>)}</div> : null}
              </li>))}
            </ol>
        );
        return (
          <Box title="Poll" id="poll" className="poll-box">
            <p class="poll-question"><strong>{p.question}</strong></p>
            <p class="poll-meta small muted">
              {open ? (p.closesAt ? <>Closes <Time d={p.closesAt} tz={tzOf(page)} /></> : 'Open') : <>Closed{p.closedAt ? <> <Time d={p.closedAt} tz={tzOf(page)} mode="ago" /></> : p.closesAt ? <> <Time d={p.closesAt} tz={tzOf(page)} mode="ago" /></> : null}</>}
              {' · '}{r.voters} {r.voters === 1 ? 'voter' : 'voters'}
              {' · '}{multiple ? `choose up to ${p.maxChoices}` : 'choose one'}
              {p.showVoters ? ' · votes are public' : ''}
            </p>
            {canVote && !mine ? <VoteForm /> : null}
            {showResults && canVote && !mine ? <details class="poll-peek"><summary>See the results so far</summary><Results /></details>
              : showResults ? <Results />
              : <p class="muted">{p.results === 'voted' ? 'Results appear once you’ve voted.' : 'Results appear when the poll closes.'}</p>}
            {mine && canVote && p.allowChange ? <details class="poll-change"><summary>Change your vote</summary><VoteForm />
              <ActionButton ctx={page} action={`/m/polls/${p.id}/retract`} label="Remove my vote" className="btn btn-small btn-ghost" /></details> : null}
            {mine && open && !p.allowChange ? <p class="small muted">Votes in this poll can’t be changed.</p> : null}
            {!v.user && open ? <p class="small"><a href={`/login?returnTo=${encodeURIComponent(pollUrl(t))}`}>Sign in to vote</a></p> : null}
            {control ? <div class="poll-controls">
              <ActionButton ctx={page} action={`/m/polls/${p.id}/${open ? 'close' : 'reopen'}`} label={open ? 'Close poll' : 'Reopen poll'} className="btn btn-small" />
              <ActionButton ctx={page} action={`/m/polls/${p.id}/delete`} label="Delete poll" className="btn btn-small btn-ghost" confirm="Delete this poll and all its votes?" />
            </div> : null}
          </Box>
        );
      },
    });

    // ── create ──
    const threadFor = async (v: Viewer, id: number) => {
      const t = await services.forums.thread(v, id);
      if (!t) throw new ServiceError('Thread not found.', 404);
      return t;
    };
    const NewPollForm = ({ page, t, values = {} }: { page: PageCtx; t: ThreadInfo; values?: Record<string, string> }) => (
      <form method="post" action="/m/polls/new" class="form-grid"><Csrf ctx={page} />
        <input type="hidden" name="thread" value={String(t.id)} />
        <Field label="Question" name="question" value={values.question ?? ''} required maxlength={LIMITS.question} placeholder="Which game for Saturday’s tournament?" />
        <TextArea label={`Answers (one per line, ${LIMITS.minOptions}–${LIMITS.maxOptions})`} name="options" value={values.options ?? ''} rows={6} required maxlength={LIMITS.maxOptions * (LIMITS.option + 2)} />
        <div class="field-row">
          <Field label="How many answers can each member pick?" name="maxChoices" type="number" value={values.maxChoices ?? '1'} attrs={{ min: '1', max: String(LIMITS.maxOptions) }} />
          <Select label="Show results" name="results" value={values.results ?? 'always'} options={Object.entries(RESULTS)} />
          <Field label={`Closes (${tzOf(page)}, optional)`} name="closesAt" type="datetime-local" value={values.closesAt ?? ''} />
        </div>
        <Checkbox label="Members can change their vote" name="allowChange" checked={values.allowChange !== '0'} />
        <Checkbox label="Show who voted for each answer" name="showVoters" checked={values.showVoters === '1'} hint="Members see this before voting, so nobody is surprised." />
        <div class="form-actions"><button class="btn btn-primary">Add poll</button> <a href={t.url}>Cancel</a></div>
      </form>
    );

    ctx.routes.get('/new', async (c) => {
      const v = c.get('viewer');
      if (!v.user) return c.redirect(`/login?returnTo=${encodeURIComponent(c.req.url.replace(/^https?:\/\/[^/]+/, ''))}`);
      const t = await threadFor(v, int(c.req.query('thread')));
      if (!(await canAdd(v, t))) throw new ServiceError(t.isLocked ? 'This thread is locked.' : 'You can only add a poll to your own threads.', 403);
      if (await pollForThread(t.id)) return c.redirect(pollUrl(t));
      const page = c.get('page');
      return ctx.render(c, 'Add a poll', (
        <>
          <h1 class="page-title">Add a poll</h1>
          <p class="page-desc">To <a href={t.url}>{t.title}</a></p>
          <Box title="Poll"><NewPollForm page={page} t={t} /></Box>
        </>
      ), { crumbs: [{ label: t.title, href: t.url }, { label: 'Add a poll' }] });
    });

    ctx.routes.post('/new', async (c) => {
      const v = c.get('viewer');
      if (!v.user) throw new ServiceError('Sign in to add a poll.', 401, 'login_required');
      const b = await form(c);
      const t = await threadFor(v, int(str(b.thread)));
      if (!(await canAdd(v, t))) throw new ServiceError('You can only add a poll to your own threads.', 403);
      const page = c.get('page');
      try {
        await createPoll(t.id, v.user.id, {
          question: cleanLine(b.question, LIMITS.question),
          options: str(b.options).split(/\r?\n/).map((o) => cleanLine(o, LIMITS.option)),
          maxChoices: int(str(b.maxChoices)) || 1,
          results: (str(b.results) || 'always') as ResultsMode,
          showVoters: bool(b.showVoters),
          allowChange: bool(b.allowChange),
          closesAt: str(b.closesAt) ? parseLocalDateTime(str(b.closesAt), tzOf(page)) : null,
        });
        setFlash(c, { type: 'ok', text: 'Poll added.' });
        return c.redirect(pollUrl(t));
      } catch (e) {
        if (!(e instanceof ServiceError) || e.status >= 500) throw e;
        const values = { question: str(b.question), options: str(b.options), maxChoices: str(b.maxChoices), results: str(b.results), closesAt: str(b.closesAt), allowChange: bool(b.allowChange) ? '1' : '0', showVoters: bool(b.showVoters) ? '1' : '0' };
        return ctx.render(c, 'Add a poll', (
          <>
            <h1 class="page-title">Add a poll</h1>
            <p class="page-desc">To <a href={t.url}>{t.title}</a></p>
            <Notice type="error">{e.message}</Notice>
            <Box title="Poll"><NewPollForm page={page} t={t} values={values} /></Box>
          </>
        ), { crumbs: [{ label: t.title, href: t.url }, { label: 'Add a poll' }], status: 400 });
      }
    });

    // ── voting and control ──
    const loadPoll = async (c: RequestContext) => {
      const v = c.get('viewer');
      const p = await pollById(int(c.req.param('id')));
      const t = p ? await services.forums.thread(v, p.threadId) : null;
      if (!p || !t || !(await v.can(P.view))) throw new ServiceError('Poll not found.', 404);
      return { p, t, v };
    };
    const action = (path: string, fn: (c: RequestContext, p: Poll, t: ThreadInfo, v: Viewer) => Promise<string>) =>
      ctx.routes.post(`/:id/${path}`, async (c) => {
        const { p, t, v } = await loadPoll(c);
        if (!v.user) throw new ServiceError('Sign in first.', 401, 'login_required');
        try { setFlash(c, { type: 'ok', text: await fn(c, p, t, v) }); }
        catch (e) { if (e instanceof ServiceError && e.status < 500) setFlash(c, { type: 'error', text: e.message }); else throw e; }
        return c.redirect(pollUrl(t));
      });

    action('vote', async (c, p, _t, v) => {
      await v.require(P.vote);
      const lim = await services.rateLimit(`polls:${v.user!.id}`, { max: 60, windowSec: 3600 });
      if (!lim.ok) throw new ServiceError('You’ve voted a lot recently. Try again later.', 429);
      const r = await vote(p, v.user!.id, arr((await form(c)).option).map((x) => parseInt(x, 10)).filter(Number.isFinite));
      return r.changed ? 'Vote changed.' : 'Thanks for voting!';
    });
    action('retract', async (_c, p, _t, v) => { await v.require(P.vote); await retract(p, v.user!.id); return 'Your vote was removed.'; });
    const control = (path: string, fn: (p: Poll) => Promise<void>, done: string) => action(path, async (_c, p, t, v) => {
      if (!(await canControl(v, t, p))) throw new ServiceError('Only the poll’s creator or a moderator can do that.', 403);
      await fn(p);
      if (p.createdBy !== v.user!.id) await services.audit(v.user!.id, `polls.${path}`, { type: 'thread', id: t.id }, { poll: p.id, question: p.question }, v.ip);
      return done;
    });
    control('close', (p) => setClosed(p, true), 'Poll closed.');
    control('reopen', (p) => setClosed(p, false), 'Poll reopened.');
    control('delete', (p) => deletePoll(p), 'Poll deleted.');

  },
});
