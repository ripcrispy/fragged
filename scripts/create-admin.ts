/**
 * Create (or promote) an administrator.
 *   npm run create-admin -- <username> <email>
 * Password is taken from ADMIN_PASSWORD or generated and printed once.
 */
import { createDb, setDb, closeDb, getDb, schema } from '../src/db/client.ts';
import { ensureBootstrap } from '../src/db/bootstrap.ts';
import { createUser, getUserByUsername } from '../src/services/users.ts';
import { groupBySlug } from '../src/services/permissions.ts';
import { hashPassword, randomToken } from '../src/lib/crypto.ts';
import { validatePassword } from '../src/lib/validate.ts';

const [username, email] = process.argv.slice(2);
if (!username || !email) { console.error('Usage: npm run create-admin -- <username> <email>'); process.exit(1); }
setDb(await createDb());
await ensureBootstrap();
const admin = (await groupBySlug('admin'))!;
let user = await getUserByUsername(username);
let generated: string | null = null;
if (!user) {
  const password = process.env.ADMIN_PASSWORD ?? (generated = randomToken(15));
  const err = validatePassword(password, { username, email });
  if (err) { console.error(err); process.exit(1); }
  user = await createUser({ username, email, emailVerified: true, passwordHash: await hashPassword(password), groupSlug: 'admin' });
} else {
  await getDb().insert(schema.userGroupMemberships).values({ userId: user.id, groupId: admin.id }).onConflictDoNothing();
}
console.log(`Administrator ready: ${user.username} (id ${user.id})`);
if (generated) console.log(`Generated password (shown once): ${generated}`);
await closeDb();
