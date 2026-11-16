import { describe, it, expect } from 'vitest';
import { compileMatcher, decide, redact, restrictedMask, profanityMatcher, profanityMask, type TermDef } from '../src/lib/filter.ts';
import { contrast, profilePalette } from '../src/lib/color.ts';
import { validateUsername, parseHexColor } from '../src/lib/validate.ts';

const terms: TermDef[] = [
  { id: 1, pattern: 'slurword', matchType: 'word', action: 'block', category: 'slur' },
  { id: 2, pattern: 'go away forever', matchType: 'phrase', action: 'hold', category: 'harassment' },
  { id: 3, pattern: 'kill\\s?yourself', matchType: 'regex', action: 'flag', category: 'harassment' },
  { id: 4, pattern: 'badname', matchType: 'word', action: 'redact', category: 'other' },
];
const m = compileMatcher(terms);

describe('restricted terms', () => {
  it('matches whole words, case-insensitively', () => {
    expect(decide(m.scan('this is a SlurWord here')).action).toBe('block');
  });
  it('catches common evasions', () => {
    for (const t of ['s1urw0rd', 'sluuurword', 's l u r w o r d', 's.l.u.r.w.o.r.d', 'ѕlurword', 'slúrword']) {
      expect(decide(m.scan(t)).action, t).toBe('block');
    }
  });
  it('does not match inside other words (low false positives)', () => {
    expect(m.scan('notslurwordish')).toHaveLength(0);
    expect(m.scan('the badnameplate')).toHaveLength(0);
  });
  it('matches phrases and regex', () => {
    expect(decide(m.scan('just Go  away, forever!')).action).toBe('hold');
    expect(decide(m.scan('you should k1ll yourself')).action).toBe('flag');
  });
  it('picks strongest action', () => {
    expect(decide(m.scan('badname and slurword')).action).toBe('block');
  });
  it('redacts spans', () => {
    const t = 'hello badname world';
    expect(redact(t, m.scan(t), restrictedMask)).toBe('hello [removed] world');
  });
});

describe('profanity (optional)', () => {
  it('masks words independently of restricted terms', () => {
    const p = profanityMatcher(['darn']);
    const t = 'well darn it';
    expect(redact(t, p.scan(t), profanityMask)).toBe('well d*** it');
  });
});

describe('colour and validation', () => {
  it('profile palettes keep text contrast >= 4.5', () => {
    for (const bg of ['#000000', '#ffffff', '#777777', '#ff0000', '#00ff00', '#0000ff', '#888888', '#7f7f00']) {
      const p = profilePalette(bg);
      expect(contrast(p.bg, p.text)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.panel, p.text)).toBeGreaterThanOrEqual(7);
    }
  });
  it('parses only hex colours', () => {
    expect(parseHexColor('#ABC')).toBe('#aabbcc');
    expect(parseHexColor('red')).toBeNull();
    expect(parseHexColor('#fff;background:url(x)')).toBeNull();
  });
  it('validates usernames and reserved names', () => {
    expect(validateUsername('Good_Name')).toBeNull();
    expect(validateUsername('ab')).toMatch(/3/);
    expect(validateUsername('Adm1n')).toMatch(/reserved/);
    expect(validateUsername('Real-Moderator')).toMatch(/reserved/);
    expect(validateUsername('bad name')).toBeTruthy();
    expect(validateUsername('-dash')).toBeTruthy();
  });
});
