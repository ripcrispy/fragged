import { z } from 'zod';
import path from 'node:path';

const bool = z.enum(['0', '1', 'true', 'false']).transform((v) => v === '1' || v === 'true');

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Public origin, e.g. https://forums.example.org (used for links, OAuth redirects, origin checks) */
  APP_URL: z.string().url().default('http://localhost:3000'),
  /** Extra exact origins allowed to submit forms (comma separated), e.g. a LAN address in development.
   *  APP_URL's origin is always allowed. Wildcards are not supported by design. */
  ALLOWED_ORIGINS: z.string().optional(),
  /** PostgreSQL URL. When absent, an embedded PGlite database is used (dev/test only). */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default('data/pglite'),
  DATA_DIR: z.string().default('data'),
  /** 32+ byte secret for HMAC/encryption. Required in production. */
  APP_SECRET: z.string().min(32).default('dev-insecure-secret-change-me-0123456789abcdef'),
  TRUST_PROXY: bool.default(false),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Fragged Forums <no-reply@localhost>'),
  /** Enables the local "Test identity provider" for exercising OAuth flows without real credentials. Never in production. */
  AUTH_DEV_PROVIDER: bool.default(false),
  /** Where visitors can get this deployment's source code (AGPL-3.0 §13). Shown as "Source code" in the footer.
   *  If you run a modified version, point this at your modified source. */
  SOURCE_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof Env> & { isProd: boolean; isTest: boolean; dataDir: string; allowedOrigins: Set<string> };

/** APP_URL's origin plus each exact origin in ALLOWED_ORIGINS (no paths, no wildcards). */
export function parseAllowedOrigins(appUrl: string, extra: string | undefined): Set<string> {
  const allowed = new Set([new URL(appUrl).origin]);
  for (const raw of (extra ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    let u: URL;
    try { u = new URL(raw); } catch { throw new Error(`ALLOWED_ORIGINS: "${raw}" is not a valid origin`); }
    if (raw.includes('*') || !/^https?:$/.test(u.protocol) || u.origin !== raw.replace(/\/$/, '')) throw new Error(`ALLOWED_ORIGINS: "${raw}" must be a bare origin like http://10.0.0.5:3000 (no path, no wildcard)`);
    allowed.add(u.origin);
  }
  return allowed;
}

function load(): Config {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.issues);
    throw new Error('Invalid environment configuration');
  }
  const env = parsed.data;
  const isProd = env.NODE_ENV === 'production';
  if (isProd) {
    if (env.APP_SECRET.startsWith('dev-insecure')) throw new Error('APP_SECRET must be set in production');
    if (env.AUTH_DEV_PROVIDER) throw new Error('AUTH_DEV_PROVIDER must not be enabled in production');
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL (PostgreSQL) is required in production');
  }
  const allowedOrigins = parseAllowedOrigins(env.APP_URL, env.ALLOWED_ORIGINS);
  return { ...env, isProd, isTest: env.NODE_ENV === 'test', dataDir: path.resolve(env.DATA_DIR), allowedOrigins };
}

export const config: Config = load();
