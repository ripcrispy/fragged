import { schema } from '../db/client.ts';
import { can, type Perm, type PermissionSubject } from './permissions.ts';
import { activeBan, getUserSettings, subjectFor, type Ban, type User, type UserSettingsRow, ServiceError } from './users.ts';
import type { Session } from './auth.ts';
import { getSetting } from './settings.ts';

/** Everything a request needs to know about who is asking. Built once per request. */
export interface Viewer {
  user: User | null;
  session: Session | null;
  subject: PermissionSubject;
  settings: UserSettingsRow;
  ban: Ban | null;
  ip: string | null;
  userAgent: string | null;
  can(perm: Perm, forumId?: number | null): Promise<boolean>;
  require(perm: Perm, forumId?: number | null): Promise<void>;
}

export const GUEST_SETTINGS = (theme: string): UserSettingsRow => ({
  userId: 0, theme, profanityFilter: true, showPresence: false, discoverable: false, dmPolicy: 'nobody', nsfwMode: 'blur', triggerMode: 'blur',
  emailNotifications: false, friendsPaneCollapsed: false, showSignatures: true, postsPerPage: 20,
});

export async function buildViewer(user: User | null, session: Session | null, ip: string | null, userAgent: string | null, guestTheme?: string): Promise<Viewer> {
  const subject = await subjectFor(user);
  const settings = user ? await getUserSettings(user.id) : GUEST_SETTINGS(guestTheme ?? (await getSetting('default_theme')));
  const ban = user ? await activeBan(user.id) : null;
  const v: Viewer = {
    user, session, subject, settings, ban, ip, userAgent,
    can: (perm, forumId = null) => can(subject, perm, forumId),
    async require(perm, forumId = null) {
      if (await can(subject, perm, forumId)) return;
      if (!user) throw new ServiceError('You need to be signed in to do that.', 401, 'login_required');
      if (ban) throw new ServiceError('Your account is currently restricted.', 403, 'banned');
      if (subject.unverified) throw new ServiceError('Please verify your email address before taking part.', 403, 'unverified');
      throw new ServiceError('You do not have permission to do that.', 403, 'forbidden');
    },
  };
  return v;
}

export function requireUser(v: Viewer): User {
  if (!v.user) throw new ServiceError('You need to be signed in to do that.', 401, 'login_required');
  return v.user;
}

export type { User };
export const _schema = schema;
