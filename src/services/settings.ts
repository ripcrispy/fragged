import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/client.ts';
import { DEFAULT_PROFANITY } from '../lib/filter.ts';
import { onBus, send } from './bus.ts';

/** Every configurable site setting with its default. Stored as JSON in `site_settings`. */
export const SETTING_DEFAULTS = {
  site_name: 'Fragged Forums',
  site_tagline: 'Talk shop. Share work. Frag responsibly.',
  default_theme: 'classic',
  announcement: '',
  maintenance_mode: false,
  maintenance_message: 'Fragged is down for scheduled maintenance. Please check back shortly.',
  // registration & accounts
  registration_open: true,
  allow_password_registration: true,
  require_email_verification: true,
  minimum_age: 13,
  require_date_of_birth: true,
  reserved_usernames: [] as string[],
  username_change_days: 30,
  // providers: enabled flag per provider (credentials come from environment variables only)
  auth_providers: { google: true, facebook: true, discord: true, apple: true, github: true, dev: true } as Record<string, boolean>,
  allow_oauth_registration: true,
  // content
  threads_per_page: 25,
  posts_per_page: 20,
  edit_window_minutes: 0, // 0 = unlimited for own posts
  delete_window_minutes: 60,
  max_tags_per_thread: 5,
  user_tag_min_posts: 10,
  established_post_threshold: 50,
  profanity_default: true,
  profanity_words: DEFAULT_PROFANITY,
  // uploads (bytes / pixels)
  upload_limits: {
    avatar: { maxBytes: 2_000_000, maxDim: 4096 },
    cover: { maxBytes: 5_000_000, maxDim: 6000 },
    post: { maxBytes: 5_000_000, maxDim: 8000, perPost: 6 },
    message: { maxBytes: 5_000_000, maxDim: 8000, perMessage: 4 },
    emoji: { maxBytes: 512_000, maxDim: 512, maxFrames: 120 },
  },
  // privacy / presence
  presence_enabled: true,
  show_online_list: true,
  // email
  email_notifications_enabled: true,
  // security
  rate_limits: {} as Record<string, { max: number; windowSec: number }>,
  session_days: 1,
  remember_days: 30,
  reauth_minutes: 15,
};
export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type Settings = typeof SETTING_DEFAULTS;

let cache: Partial<Settings> | null = null;

export async function loadSettings(): Promise<Settings> {
  if (!cache) {
    const rows = await getDb().select().from(schema.siteSettings);
    cache = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<Settings>;
  }
  return { ...SETTING_DEFAULTS, ...cache } as Settings;
}
export async function getSetting<K extends SettingKey>(key: K): Promise<Settings[K]> {
  return (await loadSettings())[key];
}
export async function setSetting<K extends SettingKey>(key: K, value: Settings[K]) {
  const db = getDb();
  await db.insert(schema.siteSettings).values({ key, value: value as any, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.siteSettings.key, set: { value: value as any, updatedAt: new Date() } });
  invalidateSettings();
}
/** Drop the cached settings on every instance. */
export function invalidateSettings() { cache = null; send('invalidate', { name: 'settings' }); }
onBus('invalidate', (m: { name: string }) => { if (m.name === 'settings') cache = null; });
export async function deleteSetting(key: SettingKey) { await getDb().delete(schema.siteSettings).where(eq(schema.siteSettings.key, key)); invalidateSettings(); }
