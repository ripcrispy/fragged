/** Core navigation links, registered like any module's so they share ordering and visibility rules. */
import { registries, CORE } from '../modules/registry.ts';
import { config } from '../config.ts';

const main: [string, string, string, number][] = [
  ['/', 'Home', 'home', 10], ['/forums', 'Forums', 'forums', 20], ['/whats-new', 'What\u2019s New', 'new', 30], ['/search', 'Search', 'search', 40],
  ['/members', 'Members', 'members', 50], ['/messages', 'Messages', 'messages', 60], ['/rules', 'Rules', 'rules', 70],
];
for (const [href, label, icon, order] of main) {
  registries.navItems.add(CORE, { href, label, icon, order, area: 'main', visible: href === '/messages' ? (v) => !!v.user : undefined });
}
const footer: [string, string, number][] = [['/rules', 'Community Rules', 10], ['/pages/terms', 'Terms of Service', 20], ['/pages/privacy', 'Privacy', 30], ['/pages/about', 'About', 40], ['/emoji', 'Emoji', 50]];
for (const [href, label, order] of footer) registries.navItems.add(CORE, { href, label, order, area: 'footer' });
// AGPL-3.0 §13: offer network users the corresponding source
if (config.SOURCE_URL) registries.navItems.add(CORE, { href: config.SOURCE_URL, label: 'Source code', order: 95, area: 'footer' });
const userMenu: [string, string, number][] = [['/friends', 'Friends', 20], ['/messages', 'Messages', 30], ['/bookmarks', 'Bookmarks', 40], ['/subscriptions', 'Subscriptions', 50], ['/settings', 'Settings', 90]];
for (const [href, label, order] of userMenu) registries.navItems.add(CORE, { href, label, order, area: 'user-menu' });
