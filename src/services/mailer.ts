/**
 * Outbound email. With SMTP_URL configured, mail is sent via nodemailer (queued as jobs).
 * Without it (development/test), messages are written to DATA_DIR/mail/*.eml and the log,
 * and kept in memory for tests via `sentMail`.
 */
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { config } from '../config.ts';
import { log } from '../lib/log.ts';
import { enqueue, registerJob } from './jobs.ts';

export interface Mail { to: string; subject: string; text: string }
export const sentMail: Mail[] = [];

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
function getTransport() {
  if (!config.SMTP_URL) return null;
  transport ??= nodemailer.createTransport(config.SMTP_URL);
  return transport;
}

async function deliver(m: Mail) {
  const t = getTransport();
  if (t) {
    await t.sendMail({ from: config.MAIL_FROM, to: m.to, subject: m.subject, text: m.text });
    return;
  }
  sentMail.push(m);
  if (sentMail.length > 200) sentMail.shift();
  if (!config.isTest) {
    const dir = path.join(config.dataDir, 'mail');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${m.subject.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.eml`);
    fs.writeFileSync(file, `From: ${config.MAIL_FROM}\nTo: ${m.to}\nSubject: ${m.subject}\n\n${m.text}\n`);
    log.info('mail written (no SMTP configured)', { to: m.to, subject: m.subject, file });
  }
}

registerJob('email', async (p: Mail) => deliver(p));

/** Security-critical mail (verification, reset) is delivered immediately; other mail is queued. */
export async function sendMail(m: Mail, opts: { immediate?: boolean } = {}) {
  if (opts.immediate || !config.SMTP_URL) return deliver(m);
  await enqueue('email', m as unknown as Record<string, unknown>);
}
