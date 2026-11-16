import { pg } from '../../src/sdk/index.ts';

export const achievementDefinitions = pg.pgTable('achievement_definitions', {
  id: pg.serial('id').primaryKey(),
  key: pg.varchar('key', { length: 48 }).notNull().unique(),
  name: pg.varchar('name', { length: 80 }).notNull(),
  description: pg.text('description').notNull().default(''),
  category: pg.varchar('category', { length: 24 }).notNull(),
  icon: pg.varchar('icon', { length: 24 }).notNull().default('medal'),
  rarity: pg.varchar('rarity', { length: 12 }).notNull().default('common'),
  criteria: pg.jsonb('criteria').$type<{ metric?: string; threshold?: number; manual?: boolean }>().notNull(),
  isActive: pg.boolean('is_active').notNull().default(true),
  displayOrder: pg.integer('display_order').notNull().default(0),
});

export const userAchievements = pg.pgTable('user_achievements', {
  id: pg.serial('id').primaryKey(),
  userId: pg.integer('user_id').notNull(),
  achievementId: pg.integer('achievement_id').notNull(),
  awardedAt: pg.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  awardedById: pg.integer('awarded_by_id'),
  revokedAt: pg.timestamp('revoked_at', { withTimezone: true }),
  revokedById: pg.integer('revoked_by_id'),
  revokeReason: pg.text('revoke_reason'),
});
