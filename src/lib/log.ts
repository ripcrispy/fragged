import { config } from '../config.ts';
const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;
function emit(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (levels[level] < levels[config.LOG_LEVEL]) return;
  if (config.isTest && level !== 'error') return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  (level === 'error' ? console.error : console.log)(line);
}
export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};
