/**
 * Caffeine model (for fun — not medical advice).
 * Each dose is absorbed linearly over `absorptionMinutes`, then eliminated with first-order kinetics
 * (half-life `halfLifeHours`, typically 3–7 h in healthy adults; ~5 h is a common average).
 */
export interface Dose { mg: number; at: Date }
export interface ModelOptions { halfLifeHours: number; absorptionMinutes: number }

export function mgAt(doses: Dose[], t: Date, o: ModelOptions): number {
  const k = Math.LN2 / (o.halfLifeHours * 3600_000);
  const abs = Math.max(0, o.absorptionMinutes) * 60_000;
  let total = 0;
  for (const d of doses) {
    const dt = t.getTime() - d.at.getTime();
    if (dt <= 0) continue;
    if (abs > 0 && dt < abs) {
      // absorbed fraction so far, with elimination of what's already in (small-step approximation)
      total += d.mg * (dt / abs) * Math.exp(-k * dt / 2);
    } else {
      total += d.mg * Math.exp(-k * (dt - abs / 2));
    }
  }
  return Math.max(0, total);
}

export interface Level { min: number; name: string; tone: 'calm' | 'ok' | 'high' | 'danger' | 'critical'; quip: string }
export const LEVELS: Level[] = [
  { min: 0, name: 'Decaf Ghost', tone: 'calm', quip: 'Barely here. Possibly asleep at the keyboard.' },
  { min: 10, name: 'Sleepy', tone: 'calm', quip: 'Running on fumes and loading screens.' },
  { min: 50, name: 'Functional', tone: 'ok', quip: 'Can read patch notes. Mostly.' },
  { min: 100, name: 'Wired', tone: 'ok', quip: 'Reflexes sharpened. Snacks recommended.' },
  { min: 200, name: 'Buzzing', tone: 'high', quip: 'Clicking heads and keyboards with equal enthusiasm.' },
  { min: 300, name: 'Vibrating', tone: 'high', quip: 'Mouse sensitivity: optional. Hands do it now.' },
  { min: 400, name: 'DANGEROUS', tone: 'danger', quip: 'Past the daily guideline. Water. Now.' },
  { min: 600, name: 'SEEING SOUND', tone: 'danger', quip: 'Can hear colours. Has opinions about tick rates.' },
  { min: 800, name: 'GO TO HOSPITAL', tone: 'critical', quip: 'Seriously — stop, drink water, tell someone.' },
];
export const levelFor = (mg: number): Level => [...LEVELS].reverse().find((l) => mg >= l.min) ?? LEVELS[0];

/** Typical caffeine per serving, from manufacturer labels and published caffeine tables (values vary by brand/region). */
export const DEFAULT_DRINKS: { name: string; category: string; servingMl: number | null; mg: number }[] = [
  { name: 'Espresso (single shot)', category: 'coffee', servingMl: 30, mg: 63 },
  { name: 'Espresso (double shot)', category: 'coffee', servingMl: 60, mg: 126 },
  { name: 'Brewed coffee (cup)', category: 'coffee', servingMl: 240, mg: 95 },
  { name: 'Brewed coffee (big mug)', category: 'coffee', servingMl: 350, mg: 140 },
  { name: 'Instant coffee', category: 'coffee', servingMl: 240, mg: 62 },
  { name: 'Cold brew', category: 'coffee', servingMl: 473, mg: 200 },
  { name: 'Latte / cappuccino', category: 'coffee', servingMl: 350, mg: 126 },
  { name: 'Decaf coffee', category: 'coffee', servingMl: 240, mg: 2 },
  { name: 'Black tea', category: 'tea', servingMl: 240, mg: 47 },
  { name: 'Green tea', category: 'tea', servingMl: 240, mg: 28 },
  { name: 'Matcha', category: 'tea', servingMl: 240, mg: 70 },
  { name: 'Yerba mate (brewed)', category: 'tea', servingMl: 240, mg: 80 },
  { name: 'Club-Mate', category: 'mate', servingMl: 500, mg: 100 },
  { name: 'Red Bull', category: 'energy', servingMl: 250, mg: 80 },
  { name: 'Red Bull (large can)', category: 'energy', servingMl: 473, mg: 151 },
  { name: 'Monster Energy', category: 'energy', servingMl: 500, mg: 160 },
  { name: 'Rockstar', category: 'energy', servingMl: 500, mg: 160 },
  { name: 'Celsius', category: 'energy', servingMl: 355, mg: 200 },
  { name: 'Bang Energy', category: 'energy', servingMl: 473, mg: 300 },
  { name: 'Energy shot (5-hour style)', category: 'energy', servingMl: 57, mg: 200 },
  { name: 'Gaming energy powder (1 scoop)', category: 'energy', servingMl: null, mg: 150 },
  { name: 'Coca-Cola (can)', category: 'soda', servingMl: 330, mg: 32 },
  { name: 'Diet Coke (can)', category: 'soda', servingMl: 330, mg: 42 },
  { name: 'Coke Zero (can)', category: 'soda', servingMl: 330, mg: 32 },
  { name: 'Pepsi (can)', category: 'soda', servingMl: 330, mg: 35 },
  { name: 'Mountain Dew (can)', category: 'soda', servingMl: 355, mg: 54 },
  { name: 'Dr Pepper (can)', category: 'soda', servingMl: 355, mg: 41 },
  { name: 'Caffeine tablet (100 mg)', category: 'tablet', servingMl: null, mg: 100 },
  { name: 'Caffeine tablet (200 mg)', category: 'tablet', servingMl: null, mg: 200 },
  { name: 'Dark chocolate (50 g bar)', category: 'snack', servingMl: null, mg: 40 },
  { name: 'Hot chocolate', category: 'snack', servingMl: 240, mg: 5 },
];
