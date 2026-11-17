import { pg } from '../../src/sdk/index.ts';
import type { FormatConfig } from './formats.ts';

const ts = (n: string) => pg.timestamp(n, { withTimezone: true });

export const tournaments = pg.pgTable('mod_lan_tournaments_tournaments', {
  id: pg.serial('id').primaryKey(),
  slug: pg.varchar('slug', { length: 80 }).notNull(),
  name: pg.varchar('name', { length: 120 }).notNull(),
  game: pg.varchar('game', { length: 80 }).notNull().default(''),
  platform: pg.varchar('platform', { length: 40 }).notNull().default(''),
  description: pg.text('description').notNull().default(''),
  rules: pg.text('rules').notNull().default(''),
  bannerUrl: pg.varchar('banner_url', { length: 200 }),
  status: pg.varchar('status', { length: 20 }).notNull().default('draft'),
  visibility: pg.varchar('visibility', { length: 10 }).notNull().default('public'),
  archived: pg.boolean('archived').notNull().default(false),
  mode: pg.varchar('mode', { length: 8 }).notNull().default('solo'),
  teamMin: pg.integer('team_min').notNull().default(1),
  teamMax: pg.integer('team_max').notNull().default(1),
  subsMax: pg.integer('subs_max').notNull().default(0),
  maxEntries: pg.integer('max_entries'),
  requireApproval: pg.boolean('require_approval').notNull().default(false),
  requireCheckin: pg.boolean('require_checkin').notNull().default(false),
  requireBooking: pg.boolean('require_booking').notNull().default(false),
  format: pg.varchar('format', { length: 20 }).notNull().default('single_elim'),
  config: pg.jsonb('config').$type<Partial<FormatConfig>>().notNull().default({}),
  lanEventId: pg.integer('lan_event_id'),
  regOpensAt: ts('reg_opens_at'),
  regClosesAt: ts('reg_closes_at'),
  checkinOpensAt: ts('checkin_opens_at'),
  startsAt: ts('starts_at'),
  endsAt: ts('ends_at'),
  createdBy: pg.integer('created_by'),
  resultsPublishedAt: ts('results_published_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const staff = pg.pgTable('mod_lan_tournaments_staff', {
  tournamentId: pg.integer('tournament_id').notNull(),
  userId: pg.integer('user_id').notNull(),
  role: pg.varchar('role', { length: 10 }).notNull(),
});

export const teams = pg.pgTable('mod_lan_tournaments_teams', {
  id: pg.serial('id').primaryKey(),
  tournamentId: pg.integer('tournament_id').notNull(),
  name: pg.varchar('name', { length: 60 }).notNull(),
  tag: pg.varchar('tag', { length: 8 }).notNull().default(''),
  captainId: pg.integer('captain_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const teamMembers = pg.pgTable('mod_lan_tournaments_team_members', {
  teamId: pg.integer('team_id').notNull(),
  tournamentId: pg.integer('tournament_id').notNull(),
  userId: pg.integer('user_id').notNull(),
  role: pg.varchar('role', { length: 10 }).notNull().default('player'),
  status: pg.varchar('status', { length: 10 }).notNull().default('invited'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const entries = pg.pgTable('mod_lan_tournaments_entries', {
  id: pg.serial('id').primaryKey(),
  tournamentId: pg.integer('tournament_id').notNull(),
  userId: pg.integer('user_id'),
  teamId: pg.integer('team_id'),
  name: pg.varchar('name', { length: 60 }).notNull(),
  status: pg.varchar('status', { length: 10 }).notNull().default('pending'),
  seed: pg.integer('seed'),
  checkedInAt: ts('checked_in_at'),
  station: pg.varchar('station', { length: 40 }).notNull().default(''),
  note: pg.varchar('note', { length: 200 }).notNull().default(''),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const invites = pg.pgTable('mod_lan_tournaments_invites', {
  tournamentId: pg.integer('tournament_id').notNull(),
  userId: pg.integer('user_id').notNull(),
  invitedBy: pg.integer('invited_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const stages = pg.pgTable('mod_lan_tournaments_stages', {
  id: pg.serial('id').primaryKey(),
  tournamentId: pg.integer('tournament_id').notNull(),
  idx: pg.integer('idx').notNull(),
  kind: pg.varchar('kind', { length: 20 }).notNull(),
  name: pg.varchar('name', { length: 60 }).notNull(),
  config: pg.jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  status: pg.varchar('status', { length: 10 }).notNull().default('active'),
});

export const matches = pg.pgTable('mod_lan_tournaments_matches', {
  id: pg.serial('id').primaryKey(),
  tournamentId: pg.integer('tournament_id').notNull(),
  stageId: pg.integer('stage_id').notNull(),
  bracket: pg.varchar('bracket', { length: 8 }).notNull().default('W'),
  round: pg.integer('round').notNull(),
  position: pg.integer('position').notNull(),
  code: pg.varchar('code', { length: 16 }).notNull(),
  bestOf: pg.integer('best_of').notNull().default(1),
  entryA: pg.integer('entry_a'),
  entryB: pg.integer('entry_b'),
  aFrom: pg.varchar('a_from', { length: 24 }),
  bFrom: pg.varchar('b_from', { length: 24 }),
  scoreA: pg.integer('score_a'),
  scoreB: pg.integer('score_b'),
  winner: pg.integer('winner'),
  loser: pg.integer('loser'),
  isDraw: pg.boolean('is_draw').notNull().default(false),
  status: pg.varchar('status', { length: 10 }).notNull().default('pending'),
  scheduledAt: ts('scheduled_at'),
  station: pg.varchar('station', { length: 40 }).notNull().default(''),
  version: pg.integer('version').notNull().default(0),
  completedAt: ts('completed_at'),
  remindedAt: ts('reminded_at'),
});

export const heatEntries = pg.pgTable('mod_lan_tournaments_heat_entries', {
  matchId: pg.integer('match_id').notNull(),
  entryId: pg.integer('entry_id').notNull(),
  placement: pg.integer('placement'),
  points: pg.integer('points'),
});

export const reports = pg.pgTable('mod_lan_tournaments_reports', {
  id: pg.serial('id').primaryKey(),
  matchId: pg.integer('match_id').notNull(),
  side: pg.varchar('side', { length: 8 }).notNull(),
  scoreA: pg.integer('score_a'),
  scoreB: pg.integer('score_b'),
  placements: pg.jsonb('placements').$type<Record<string, number>>(),
  reportedBy: pg.integer('reported_by'),
  status: pg.varchar('status', { length: 10 }).notNull().default('pending'),
  disputeReason: pg.varchar('dispute_reason', { length: 300 }).notNull().default(''),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const attempts = pg.pgTable('mod_lan_tournaments_attempts', {
  id: pg.serial('id').primaryKey(),
  tournamentId: pg.integer('tournament_id').notNull(),
  entryId: pg.integer('entry_id').notNull(),
  value: pg.integer('value').notNull(),
  proof: pg.varchar('proof', { length: 300 }).notNull().default(''),
  status: pg.varchar('status', { length: 10 }).notNull().default('pending'),
  submittedBy: pg.integer('submitted_by'),
  reviewedBy: pg.integer('reviewed_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const announcements = pg.pgTable('mod_lan_tournaments_announcements', {
  id: pg.serial('id').primaryKey(),
  tournamentId: pg.integer('tournament_id').notNull(),
  body: pg.text('body').notNull(),
  createdBy: pg.integer('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const results = pg.pgTable('mod_lan_tournaments_results', {
  id: pg.serial('id').primaryKey(),
  tournamentId: pg.integer('tournament_id').notNull(),
  entryId: pg.integer('entry_id'),
  userId: pg.integer('user_id'),
  name: pg.varchar('name', { length: 60 }).notNull(),
  teamName: pg.varchar('team_name', { length: 60 }).notNull().default(''),
  place: pg.integer('place').notNull(),
  points: pg.integer('points').notNull().default(0),
  wins: pg.integer('wins').notNull().default(0),
  losses: pg.integer('losses').notNull().default(0),
  draws: pg.integer('draws').notNull().default(0),
});

export type Tournament = typeof tournaments.$inferSelect;
export type Entry = typeof entries.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type Stage = typeof stages.$inferSelect;
export type Match = typeof matches.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type Attempt = typeof attempts.$inferSelect;
