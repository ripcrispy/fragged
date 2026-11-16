/** Idempotent required data: groups, warning tags, rules and policy pages. */
import { eq } from 'drizzle-orm';
import { getDb, schema } from './client.ts';
import { ensureDefaultGroups } from '../services/permissions.ts';

const WARNING_TAGS = [
  { name: 'Spoiler', slug: 'spoiler', description: 'Reveals plot or game details. Content is hidden until the reader opts in.' },
  { name: 'NSFW', slug: 'nsfw', description: 'Not safe for work: crude language or mature themes permitted by the rules. Explicit sexual content is still prohibited.' },
  { name: 'Trigger Warning', slug: 'trigger-warning', description: 'Discusses topics some members may find distressing.' },
];
const TOPIC_TAGS = ['Discussion', 'Question', 'Showcase', 'WIP', 'Tutorial', 'Release', 'News', 'Meta', 'Feedback'];

export const RULES = [
  ['The basics', 'Be decent', 'Argue with ideas, not people. Personal attacks, harassment, threats and pile-ons are not allowed.'],
  ['The basics', 'No hate speech', 'Slurs and content that attacks people for who they are (race, ethnicity, religion, disability, gender, sexual orientation and similar) are removed and may lead to an immediate ban. A filter enforces part of this automatically; context still matters and moderators make the final call.'],
  ['The basics', 'Keep it legal and safe', 'No illegal content, piracy links, malware, doxxing or sharing anyone\'s private information. No sexual content involving minors — ever.'],
  ['Posting', 'Label sensitive content', 'Use the [b]Spoiler[/b], [b]NSFW[/b] and [b]Trigger Warning[/b] labels when they apply, and wrap plot details in [spoiler]…[/spoiler]. Labels are a courtesy, not a loophole: explicit sexual content is not allowed anywhere.'],
  ['Posting', 'Post in the right place', 'Pick the forum that fits, search before starting a new thread, and give threads descriptive titles.'],
  ['Posting', 'No spam', 'No advertising, referral links, repeated low-effort posts or reaction farming. Achievements and reactions don\'t reward volume.'],
  ['Posting', 'Share, don\'t steal', 'Credit creators. Only upload images you have the right to share. Videos and files are shared as links, not uploads.'],
  ['Accounts', 'One account each', 'Alternate accounts used to dodge bans or manipulate discussions will be closed. Don\'t impersonate other members or staff.'],
  ['Accounts', 'Direct messages', 'DMs are private but not lawless — harassment by message is still harassment. Use Block if someone bothers you and Report if they break the rules.'],
  ['Moderation', 'How moderation works', 'Moderators may edit, move, lock or remove content and issue warnings, suspensions or bans. Every staff action is logged. If you disagree with a decision, message a moderator calmly or post in Site Feedback.'],
];

const PAGES: Record<string, { title: string; body: string }> = {
  'rules-intro': { title: 'Rules introduction', body: 'Fragged is a place to talk shop, share work and hang out. These rules keep it that way. They apply everywhere on the site, including profiles, emoji and direct messages.' },
  terms: { title: 'Terms of Service', body: `[b]Summary:[/b] you own what you post, you grant Fragged a licence to display it, and you follow the Community Rules.

[h]Your account[/h]You must meet the minimum age set for this community. You are responsible for activity on your account. Keep your sign-in methods secure.

[h]Your content[/h]You keep ownership of what you post. By posting you grant Fragged a non-exclusive, worldwide licence to host, display and distribute it as part of the service. Don't post content you don't have the rights to.

[h]Conduct[/h]Follow the [url=/rules]Community Rules[/url]. We may remove content or restrict accounts that break them.

[h]Third-party content[/h]Embedded videos, Spotify players and external links come from third parties under their own terms. Fragged never uploads or mirrors videos or files you link to.

[h]Changes[/h]We may update these terms; significant changes will be announced on the forum.` },
  privacy: { title: 'Privacy Policy', body: `[h]What we collect[/h][list]
[*]Account data: username, email address (optional for provider sign-ups), password hash, date of birth (for age checks; never shown), timezone.
[*]Linked sign-in providers: the provider's account ID, and the email and display name it shares. We do not store provider passwords or access tokens.
[*]Content you post: threads, posts, profile details, comments, reactions, uploaded images (re-encoded, metadata such as GPS removed).
[*]Direct messages and their attachments.
[*]Security data: IP address and browser string for sessions and security events, kept to protect accounts.
[/list]
[h]Who can see it[/h]Forum content is visible to anyone who can access the forum. Your profile visibility, online status, member-directory listing and who can message you are controlled in [url=/settings/privacy]Settings › Privacy[/url]. Email addresses and dates of birth are never shown publicly or included in search.

[h]Direct messages[/h]Messages are private to the two participants and are never shown in search, profiles or activity feeds. Sent messages cannot be edited or deleted by users and are kept for the life of the service, so both participants keep an accurate history. Staff can only view a message that has been reported, through an audited process, and may hide it from both participants; the original is retained for appeals and legal obligations. Where the law requires us to delete or disclose data (for example a valid erasure request or court order), we will do so and that overrides this retention practice.

[h]Closing your account[/h]Closing your account removes your profile, email, sign-in methods and friendships. Posts and messages you sent remain, attributed to "Former member", so conversations stay coherent. You can request full erasure of personal data by contacting the administrators; we'll honour it where the law requires.

[h]Cookies[/h]We use essential cookies only: your session, a security (CSRF) token, short-lived sign-in state, and your theme choice as a guest. No advertising or tracking cookies.

[h]Embeds[/h]YouTube, Vimeo and Spotify content only loads after you click it, at which point the provider may set its own cookies.` },
  about: { title: 'About Fragged', body: 'Fragged is an independent community for people who play, make and break games. It is run by its members and volunteer staff and is not affiliated with any game studio or publisher.' },
};

export async function ensureBootstrap() {
  const db = getDb();
  await ensureDefaultGroups();
  for (const t of WARNING_TAGS) await db.insert(schema.tags).values({ ...t, kind: 'warning', isOfficial: true }).onConflictDoNothing();
  for (const name of TOPIC_TAGS) await db.insert(schema.tags).values({ name, slug: name.toLowerCase(), kind: 'topic', isOfficial: true }).onConflictDoNothing();
  const existingRules = await db.select({ id: schema.rules.id }).from(schema.rules).limit(1);
  if (!existingRules.length) await db.insert(schema.rules).values(RULES.map(([section, title, body], i) => ({ section, title, body, displayOrder: i })));
  for (const [slug, p] of Object.entries(PAGES)) {
    const [ex] = await db.select({ id: schema.staticPages.id }).from(schema.staticPages).where(eq(schema.staticPages.slug, slug));
    if (!ex) await db.insert(schema.staticPages).values({ slug, ...p });
  }
}
