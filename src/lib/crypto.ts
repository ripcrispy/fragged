import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.ts';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;

/** scrypt parameters (N=2^15, r=8, p=1 ≈ 32 MiB). Stored with the hash so they can be raised later. */
const N = 1 << 15, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    // equalise timing for unknown users / passwordless accounts
    await scrypt('x', Buffer.alloc(16), KEYLEN, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
    return false;
  }
  const [alg, n, r, p, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, { N: +n, r: +r, p: +p, maxmem: 128 * +n * +r * 2 });
  return crypto.timingSafeEqual(key, expected);
}

export function randomToken(bytes = 32): string { return crypto.randomBytes(bytes).toString('base64url'); }
export function publicId(len = 12): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[buf[i] % alphabet.length];
  return s;
}
export function sha256(s: string | Buffer): string { return crypto.createHash('sha256').update(s).digest('hex'); }
export function hmac(s: string): string { return crypto.createHmac('sha256', config.APP_SECRET).update(s).digest('base64url'); }
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const encKey = () => crypto.createHash('sha256').update('enc:' + config.APP_SECRET).digest();
/** AES-256-GCM for secrets at rest (e.g. provider refresh tokens). */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}
export function decrypt(token: string): string {
  const [iv, tag, ct] = token.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
