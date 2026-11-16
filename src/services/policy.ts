/**
 * Content policy service: mandatory restricted terms (DB) + optional profanity list (setting).
 * See lib/filter.ts for matching semantics.
 */
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { compileMatcher, decide, redact, restrictedMask, profanityMatcher, profanityMask, type Matcher, type TermDef, type PolicyDecision } from '../lib/filter.ts';
import { getSetting } from './settings.ts';
import { onBus, send } from './bus.ts';
import { ServiceError } from './users.ts';

let restricted: Matcher | null = null;
let profanity: { words: string; m: Matcher } | null = null;
/** Drop compiled term matchers on every instance. */
export function invalidatePolicy() { restricted = null; profanity = null; send('invalidate', { name: 'policy' }); }
onBus('invalidate', (m: { name: string }) => { if (m.name === 'policy') { restricted = null; profanity = null; } });

async function restrictedMatcher(): Promise<Matcher> {
  if (!restricted) {
    const rows = await getDb().select().from(schema.restrictedTerms).where(eq(schema.restrictedTerms.isActive, true));
    restricted = compileMatcher(rows.map((r) => ({ id: r.id, pattern: r.pattern, matchType: r.matchType as TermDef['matchType'], action: r.action as TermDef['action'], category: r.category })));
  }
  return restricted;
}
async function profanityM(): Promise<Matcher> {
  const words = await getSetting('profanity_words');
  const key = words.join('\n');
  if (!profanity || profanity.words !== key) profanity = { words: key, m: profanityMatcher(words) };
  return profanity.m;
}

/**
 * Evaluate submitted content against mandatory restricted terms. Always runs, regardless of any
 * user preference. Records matches for moderator review. Throws on `block`.
 * Returns `held: true` if content must wait for moderation.
 */
export async function enforcePolicy(text: string, ctx: { userId: number; contentType: string; contentId?: number | null }): Promise<{ held: boolean; decision: PolicyDecision }> {
  const m = await restrictedMatcher();
  const decision = decide(m.scan(text));
  if (!decision.action) return { held: false, decision };
  const db = getDb();
  const rows = decision.matches.filter((x) => x.action !== 'redact' || true).slice(0, 10).map((x) => ({
    termId: x.termId, userId: ctx.userId, contentType: ctx.contentType, contentId: ctx.contentId ?? null, action: decision.action!,
    excerpt: text.slice(Math.max(0, x.start - 40), x.end + 40).slice(0, 200),
    reviewStatus: decision.action === 'redact' ? 'upheld' : 'pending',
  }));
  if (rows.length) await db.insert(schema.restrictedTermMatches).values(rows);
  if (decision.action === 'block') {
    throw new ServiceError('Your message contains language that is not permitted by the community rules. Please revise it and try again.', 422, 'restricted');
  }
  return { held: decision.action === 'hold', decision };
}

/** Attach the content id to matches recorded before the content existed. */
export async function linkMatches(userId: number, contentType: string, contentId: number) {
  const { and, isNull, gt } = await import('drizzle-orm');
  await getDb().update(schema.restrictedTermMatches).set({ contentId })
    .where(and(eq(schema.restrictedTermMatches.userId, userId), eq(schema.restrictedTermMatches.contentType, contentType), isNull(schema.restrictedTermMatches.contentId), gt(schema.restrictedTermMatches.createdAt, new Date(Date.now() - 60_000))));
}

/**
 * Build the display text filter for a viewer: restricted terms are always redacted; the
 * optional profanity mask is applied only when the viewer has it enabled.
 */
export async function textFilterFor(profanityEnabled: boolean): Promise<(s: string) => string> {
  const r = await restrictedMatcher();
  const p = profanityEnabled ? await profanityM() : null;
  return (s: string) => {
    let out = redact(s, r.scan(s), restrictedMask);
    if (p) out = redact(out, p.scan(out), profanityMask);
    return out;
  };
}

/** Test a candidate term against sample text without saving (admin review workflow). */
export function testTerm(def: Omit<TermDef, 'id'>, samples: string[]) {
  const m = compileMatcher([{ ...def, id: 0 }]);
  return samples.map((s) => ({ sample: s, matches: m.scan(s).map((x) => x.text) }));
}

export function validateRegex(pattern: string): string | null {
  if (pattern.length > 200) return 'Patterns must be at most 200 characters.';
  // reject constructs prone to catastrophic backtracking: nested quantifiers like (a+)+
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) return 'Nested quantifiers are not allowed (risk of slow matching).';
  try { new RegExp(pattern, 'giu'); } catch (e) { return 'Invalid regular expression: ' + String((e as Error).message); }
  return null;
}
