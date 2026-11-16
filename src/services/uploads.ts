/**
 * Image uploads. Only raster images are accepted (JPEG, PNG, WebP, GIF; never SVG).
 * Every image is:
 *   - checked by decoding its actual content (the declared MIME type / extension is ignored),
 *   - bounded by byte size, pixel dimensions and animation frame count (decompression-bomb guard),
 *   - re-encoded to WebP (animation preserved only where the purpose allows it),
 *   - stripped of EXIF/GPS and other metadata (sharp drops metadata unless asked to keep it),
 *   - stored under DATA_DIR/uploads (outside any web root) and served via an access-checked route.
 *
 * Videos and general files are NOT uploadable anywhere — they are shared as external links.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { config } from '../config.ts';
import { publicId, sha256 } from '../lib/crypto.ts';
import { getSetting } from './settings.ts';
import { ServiceError } from './users.ts';

export type Purpose = 'avatar' | 'cover' | 'post' | 'message' | 'emoji';
export type Upload = typeof schema.uploads.$inferSelect;

sharp.cache(false);
sharp.concurrency(1);

const ACCEPTED = new Set(['jpeg', 'png', 'webp', 'gif']);

interface Spec { width: number; height: number; fit: 'cover' | 'inside' | 'contain'; animated: boolean; quality: number }
const SPECS: Record<Purpose, Spec> = {
  avatar: { width: 256, height: 256, fit: 'cover', animated: false, quality: 85 },
  cover: { width: 1600, height: 500, fit: 'cover', animated: false, quality: 82 },
  post: { width: 2000, height: 2000, fit: 'inside', animated: true, quality: 82 },
  message: { width: 1600, height: 1600, fit: 'inside', animated: true, quality: 80 },
  emoji: { width: 128, height: 128, fit: 'contain', animated: true, quality: 90 },
};

export const storageRoot = () => path.join(config.dataDir, 'uploads');

/** Storage driver (local disk). Swap for S3-compatible object storage in production if desired. */
export const storage = {
  async put(key: string, data: Buffer) {
    const file = path.join(storageRoot(), key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data, { mode: 0o640 });
  },
  async get(key: string): Promise<Buffer> {
    const file = path.join(storageRoot(), key);
    if (!file.startsWith(storageRoot() + path.sep)) throw new Error('bad key');
    return fs.readFile(file);
  },
  async remove(key: string) { await fs.rm(path.join(storageRoot(), key), { force: true }); },
};

export interface ProcessOptions { gravity?: 'centre' | 'north' | 'south' | 'attention' }

export async function processImage(input: Buffer, purpose: Purpose, opts: ProcessOptions = {}): Promise<{ data: Buffer; width: number; height: number; animated: boolean; inputSha: string }> {
  const limits = (await getSetting('upload_limits'))[purpose] as { maxBytes: number; maxDim: number; maxFrames?: number };
  if (!input.length) throw new ServiceError('The file is empty.');
  if (input.length > limits.maxBytes) throw new ServiceError(`Images must be at most ${Math.round(limits.maxBytes / 1000)} KB.`, 413);
  const head = input.subarray(0, 512).toString('utf8').toLowerCase();
  if (head.includes('<svg') || head.includes('<?xml') || head.includes('<html')) throw new ServiceError('SVG and HTML files are not accepted. Please upload a PNG, JPEG, WebP or GIF image.', 415);
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    // header-only parse; pixel limits are enforced below and again when decoding
    meta = await sharp(input, { limitInputPixels: false, failOn: 'error' }).metadata();
  } catch {
    throw new ServiceError('That file is not a valid image. Accepted formats: PNG, JPEG, WebP, GIF.', 415);
  }
  if (!meta.format || !ACCEPTED.has(meta.format)) throw new ServiceError('Accepted image formats: PNG, JPEG, WebP, GIF.', 415);
  const w = meta.width ?? 0, h = (meta.pageHeight ?? meta.height) ?? 0;
  if (!w || !h || w > limits.maxDim || h > limits.maxDim) throw new ServiceError(`Images must be at most ${limits.maxDim}×${limits.maxDim} pixels.`, 413);
  const pages = meta.pages ?? 1;
  const spec = SPECS[purpose];
  const maxFrames = limits.maxFrames ?? 200;
  if (pages > maxFrames) throw new ServiceError(`Animated images may have at most ${maxFrames} frames.`, 413);
  if (pages * w * h > 150_000_000) throw new ServiceError('That animation is too large to process.', 413);
  const animated = spec.animated && pages > 1;
  try {
    let img = sharp(input, { animated, limitInputPixels: limits.maxDim * limits.maxDim * Math.max(1, animated ? pages : 1) }).rotate();
    img = img.resize({ width: spec.width, height: spec.height, fit: spec.fit, withoutEnlargement: spec.fit === 'inside', position: opts.gravity ?? 'centre', background: { r: 0, g: 0, b: 0, alpha: 0 } });
    const { data, info } = await img.webp({ quality: spec.quality, effort: 3 }).toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: (info as any).pageHeight ?? info.height, animated, inputSha: sha256(input) };
  } catch {
    throw new ServiceError('The image could not be processed.', 415);
  }
}

export async function saveUpload(userId: number, purpose: Purpose, input: Buffer, originalName: string | null, opts: ProcessOptions = {}): Promise<Upload> {
  const p = await processImage(input, purpose, opts);
  const pid = publicId(20);
  const key = `${purpose}/${pid.slice(0, 2)}/${pid}.webp`;
  await storage.put(key, p.data);
  const [row] = await getDb().insert(schema.uploads).values({
    publicId: pid, userId, purpose, storageKey: key, mime: 'image/webp', width: p.width, height: p.height, bytes: p.data.length,
    animated: p.animated, sha256: p.inputSha, originalName: originalName?.replace(/[^\w.\- ]/g, '_').slice(0, 200) ?? null,
  }).returning();
  return row;
}

export async function getUpload(pid: string): Promise<Upload | null> {
  if (!/^[A-Za-z0-9]{8,32}$/.test(pid)) return null;
  const [u] = await getDb().select().from(schema.uploads).where(eq(schema.uploads.publicId, pid));
  return u ?? null;
}

/** Read a File/Blob from a multipart form into a Buffer with a hard cap. */
export async function fileToBuffer(f: unknown, cap = 10_000_000): Promise<{ buf: Buffer; name: string } | null> {
  if (!f || typeof f !== 'object' || !('arrayBuffer' in (f as any))) return null;
  const file = f as File;
  if (file.size === 0) return null;
  if (file.size > cap) throw new ServiceError('That file is too large.', 413);
  return { buf: Buffer.from(await file.arrayBuffer()), name: file.name ?? 'image' };
}
