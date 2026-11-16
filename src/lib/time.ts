/** Date formatting in the viewer's timezone (forum-style). */
export function fmtDate(d: Date | null | undefined, tz = 'UTC'): string {
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  } catch { return d.toISOString().slice(0, 10); }
}
export function fmtDateTime(d: Date | null | undefined, tz = 'UTC'): string {
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
  } catch { return d.toISOString().replace('T', ' ').slice(0, 16); }
}
export function fmtMonthYear(d: Date | null | undefined, tz = 'UTC'): string {
  if (!d) return '';
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, month: 'long', year: 'numeric' }).format(d); } catch { return ''; }
}
export function timeAgo(d: Date | null | undefined, now = Date.now()): string {
  if (!d) return '';
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  const units: [number, string][] = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [604800, 'week'], [2629800, 'month'], [31557600, 'year']];
  let chosen: [number, string] = units[0];
  for (const u of units) if (s >= u[0]) chosen = u;
  const n = Math.max(1, Math.floor(s / chosen[0]));
  return `${n} ${chosen[1]}${n === 1 ? '' : 's'} ago`;
}
export function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}
export function numberFmt(n: number): string { return n.toLocaleString('en-GB'); }

/** Offset (ms) of `tz` from UTC at instant `d`. */
function tzOffset(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - d.getTime();
}
/** Parse an <input type="datetime-local"> value ("YYYY-MM-DDTHH:mm") as wall-clock time in `tz`. */
export function parseLocalDateTime(value: string, tz = 'UTC'): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if (isNaN(guess)) return null;
  let t = guess - tzOffset(new Date(guess), isValidTimezone(tz) ? tz : 'UTC');
  t = guess - tzOffset(new Date(t), isValidTimezone(tz) ? tz : 'UTC'); // second pass handles DST edges
  return new Date(t);
}
/** Format a Date for an <input type="datetime-local"> in `tz`. */
export function toLocalInput(d: Date | null | undefined, tz = 'UTC'): string {
  if (!d) return '';
  const local = new Date(d.getTime() + tzOffset(d, isValidTimezone(tz) ? tz : 'UTC'));
  return local.toISOString().slice(0, 16);
}
