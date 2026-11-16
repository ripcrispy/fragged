/**
 * Two independent content-policy layers:
 *
 * 1. Mandatory restricted terms (admin-defined). Evaluated on submission (block / hold / flag)
 *    and redacted on display for every viewer. User preferences can never bypass them.
 * 2. Optional profanity filter. Presentation-only masking, applied when the viewer enables it.
 *
 * Stored content is never rewritten; both layers act at submit time (decision) or render time.
 *
 * Matching works on normalised tokens: NFKC + case-fold, diacritics stripped, common leetspeak
 * and Cyrillic/Greek look-alikes mapped, repeated letters collapsed, and runs of single
 * letters ("s l u r", "s.l.u.r") joined. Word terms match whole tokens only, which keeps
 * false positives (the "Scunthorpe problem") low.
 */

export type TermAction = 'block' | 'hold' | 'flag' | 'redact';
export interface TermDef { id: number; pattern: string; matchType: 'word' | 'phrase' | 'regex'; action: TermAction; category: string }
export interface TermMatch { termId: number; action: TermAction; category: string; start: number; end: number; text: string }

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't', '€': 'e', '¡': 'i' };
const CONFUSABLE: Record<string, string> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'к': 'k', 'м': 'm', 'т': 't', 'в': 'b', 'н': 'h',
  'α': 'a', 'ε': 'e', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'ι': 'i', 'κ': 'k', 'ν': 'v',
};

export function normToken(tok: string, collapse = true, foldIL = true): string {
  // boundary punctuation is sentence punctuation, not leetspeak
  let s = tok.replace(/^[!|+*¡]+|[!|+*¡]+$/g, '');
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = [...s].map((c) => CONFUSABLE[c] ?? LEET[c] ?? c).join('');
  // '1', '|' and '!' stand in for both i and l, so i/l are folded together on both sides
  s = s.replace(/[^a-z0-9]/g, '');
  if (foldIL) s = s.replace(/l/g, 'i');
  return collapse ? s.replace(/(.)\1+/g, '$1') : s;
}

interface Tok { norm: string; full: string; start: number; end: number }

const TOKEN_RE = /[\p{L}\p{N}@$!|+€¡*]+/gu;

export function tokenize(text: string): Tok[] {
  const raw: Tok[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const norm = normToken(m[0]);
    if (norm) raw.push({ norm, full: normToken(m[0], false, false), start: m.index!, end: m.index! + m[0].length });
  }
  // join runs of 2+ single-letter tokens separated only by spaces/punctuation (s.l.u.r / s l u r)
  const out: Tok[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].norm.length === 1) {
      let j = i;
      while (j + 1 < raw.length && raw[j + 1].norm.length === 1 && raw[j + 1].start - raw[j].end <= 2) j++;
      if (j > i) {
        const full = raw.slice(i, j + 1).map((t) => t.full).join('');
        out.push({ norm: raw.slice(i, j + 1).map((t) => t.norm).join('').replace(/(.)\1+/g, '$1'), full, start: raw[i].start, end: raw[j].end });
        i = j;
        continue;
      }
    }
    out.push(raw[i]);
  }
  return out;
}

export interface Matcher { scan(text: string): TermMatch[] }

export function compileMatcher(terms: TermDef[]): Matcher {
  const words = new Map<string, TermDef>();
  const phrases: { toks: string[]; def: TermDef }[] = [];
  const regexes: { re: RegExp; def: TermDef }[] = [];
  for (const t of terms) {
    if (t.matchType === 'regex') {
      try {
        if (t.pattern.length <= 200) regexes.push({ re: new RegExp(t.pattern, 'giu'), def: t });
      } catch { /* invalid patterns are rejected at save time */ }
    } else {
      const toks = tokenize(t.pattern).map((x) => x.norm);
      if (!toks.length) continue;
      if (toks.length === 1 && t.matchType === 'word') words.set(toks[0], t);
      else phrases.push({ toks, def: t });
    }
  }
  return {
    scan(text: string): TermMatch[] {
      if (!text) return [];
      const toks = tokenize(text);
      const out: TermMatch[] = [];
      for (const tk of toks) {
        const d = words.get(tk.norm);
        if (d) out.push({ termId: d.id, action: d.action, category: d.category, start: tk.start, end: tk.end, text: text.slice(tk.start, tk.end) });
      }
      for (const p of phrases) {
        for (let i = 0; i + p.toks.length <= toks.length; i++) {
          let ok = true;
          for (let k = 0; k < p.toks.length; k++) if (toks[i + k].norm !== p.toks[k]) { ok = false; break; }
          if (ok) {
            const s = toks[i].start, e = toks[i + p.toks.length - 1].end;
            out.push({ termId: p.def.id, action: p.def.action, category: p.def.category, start: s, end: e, text: text.slice(s, e) });
          }
        }
      }
      if (regexes.length) {
        // regexes run against a lightly normalised token stream (lowercase, leetspeak and
        // look-alikes mapped, no letter folding), mapped back to original spans
        for (const field of ['full'] as const) {
          let norm = '';
          const offs: { ns: number; ne: number; t: Tok }[] = [];
          for (const t of toks) { const ns = norm.length; norm += t[field]; offs.push({ ns, ne: norm.length, t }); norm += ' '; }
          for (const { re, def } of regexes) {
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            let guard = 0;
            while ((m = re.exec(norm)) && guard++ < 100) {
              if (m[0].length === 0) { re.lastIndex++; continue; }
              const ms = m.index, me = m.index + m[0].length;
              const covered = offs.filter((o) => o.ne > ms && o.ns < me);
              if (!covered.length) continue;
              const s = covered[0].t.start, e = covered[covered.length - 1].t.end;
              if (out.some((x) => x.termId === def.id && x.start === s)) continue;
              out.push({ termId: def.id, action: def.action, category: def.category, start: s, end: e, text: text.slice(s, e) });
            }
          }
        }
      }
      return out.sort((a, b) => a.start - b.start);
    },
  };
}

const RANK: Record<TermAction, number> = { redact: 1, flag: 2, hold: 3, block: 4 };

export interface PolicyDecision { action: TermAction | null; matches: TermMatch[] }

/** Strongest action among matches. */
export function decide(matches: TermMatch[]): PolicyDecision {
  let action: TermAction | null = null;
  for (const m of matches) if (!action || RANK[m.action] > RANK[action]) action = m.action;
  return { action, matches };
}

/** Replace matched spans. */
export function redact(text: string, matches: { start: number; end: number }[], mask: (s: string) => string): string {
  if (!matches.length) return text;
  let out = '', pos = 0;
  for (const m of [...matches].sort((a, b) => a.start - b.start)) {
    if (m.start < pos) continue;
    out += text.slice(pos, m.start) + mask(text.slice(m.start, m.end));
    pos = m.end;
  }
  return out + text.slice(pos);
}

export const restrictedMask = () => '[removed]';
export const profanityMask = (s: string) => (s.length <= 1 ? '*' : s[0] + '*'.repeat(Math.min(s.length - 1, 8)));

/** Default optional profanity list (mild, general). Admins can edit it under Restricted terms › Profanity list. */
export const DEFAULT_PROFANITY = ['fuck', 'fucking', 'fucker', 'shit', 'shitty', 'bullshit', 'bitch', 'bastard', 'asshole', 'arsehole', 'dick', 'dickhead', 'piss', 'pissed', 'crap', 'damn', 'bollocks', 'wanker', 'twat', 'prick', 'motherfucker'];

export function profanityMatcher(words: string[]): Matcher {
  return compileMatcher(words.map((w, i) => ({ id: -1 - i, pattern: w, matchType: 'word' as const, action: 'redact' as const, category: 'profanity' })));
}
