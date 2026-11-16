/**
 * Seat-map text format, one line per row:
 *   S  bookable seat      V  reserved (organisers assign)      X  blocked seat
 *   .  aisle / gap        #  table, wall or stage
 * Rows are lettered A, B, … (AA after Z). Seats are numbered left to right within a row, counting S, V and X,
 * so seat codes stay stable when aisles move: "A1", "B12".
 */
export type CellKind = 'seat' | 'reserved' | 'blocked' | 'aisle' | 'table';
export interface Cell { kind: CellKind; code: string | null }
export interface Layout { rows: Cell[][]; seats: Map<string, CellKind>; width: number; errors: string[] }

export const MAX_ROWS = 60, MAX_COLS = 80;
const KIND: Record<string, CellKind> = { S: 'seat', V: 'reserved', X: 'blocked', '.': 'aisle', '#': 'table', ' ': 'aisle' };

export function rowLabel(i: number): string {
  let s = '', n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

export function parseLayout(text: string): Layout {
  const errors: string[] = [];
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l, i, a) => l.length || i < a.length - 1);
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (!lines.length) errors.push('The layout is empty.');
  if (lines.length > MAX_ROWS) errors.push(`At most ${MAX_ROWS} rows.`);
  const seats = new Map<string, CellKind>();
  let width = 0;
  const rows = lines.slice(0, MAX_ROWS).map((line, r) => {
    if (line.length > MAX_COLS) errors.push(`Row ${rowLabel(r)} is longer than ${MAX_COLS} characters.`);
    let n = 0;
    width = Math.max(width, Math.min(line.length, MAX_COLS));
    return [...line.slice(0, MAX_COLS).toUpperCase()].map((ch) => {
      const kind = KIND[ch];
      if (!kind) { errors.push(`Unknown character "${ch}" in row ${rowLabel(r)}.`); return { kind: 'aisle' as CellKind, code: null }; }
      if (kind === 'seat' || kind === 'reserved' || kind === 'blocked') {
        const code = `${rowLabel(r)}${++n}`;
        seats.set(code, kind);
        return { kind, code };
      }
      return { kind, code: null };
    });
  });
  if (!errors.length && ![...seats.values()].some((k) => k === 'seat' || k === 'reserved')) errors.push('The layout has no seats (use S for a bookable seat).');
  return { rows, seats, width, errors: [...new Set(errors)].slice(0, 8) };
}

export const capacity = (l: Layout) => [...l.seats.values()].filter((k) => k === 'seat' || k === 'reserved').length;
