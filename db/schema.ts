import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const bottles = pgTable("bottles", {
  id: serial("id").primaryKey(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  destroyedAt: timestamp("destroyed_at", { withTimezone: true }),
  authorVisitor: varchar("author_visitor", { length: 64 }).notNull(),
}, (table) => [
  check("bottles_text_len", sql`length(${table.text}) between 5 and 240`),
  index("bottles_author_created_idx").on(table.authorVisitor, table.createdAt),
  index("bottles_author_id_idx").on(table.authorVisitor, table.id),
]);

export const bottleViews = pgTable("bottle_views", {
  bottleId: integer("bottle_id")
    .notNull()
    .references(() => bottles.id, { onDelete: "cascade" }),
  visitorId: varchar("visitor_id", { length: 64 }).notNull(),
  seenAt: timestamp("seen_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ columns: [table.bottleId, table.visitorId] })]);

export const reservations = pgTable("reservations", {
  bottleId: integer("bottle_id")
    .primaryKey()
    .references(() => bottles.id, { onDelete: "cascade" }),
  visitorId: varchar("visitor_id", { length: 64 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
}, (table) => [
  // Solo una reserva *sin confirmar* por visitante: las conversaciones fijas no ocupan hueco.
  uniqueIndex("reservations_visitor_pendiente").on(table.visitorId)
    .where(sql`${table.confirmedAt} is null`),
  check(
    "reservations_confirmada_infinita",
    sql`${table.confirmedAt} is null or ${table.expiresAt} = 'infinity'`,
  ),
]);

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  bottleId: integer("bottle_id")
    .notNull()
    .references(() => bottles.id, { onDelete: "cascade" }),
  senderVisitor: varchar("sender_visitor", { length: 64 }).notNull(),
  senderAlias: varchar("sender_alias", { length: 20 }).notNull(),
  text: varchar("text", { length: 500 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("messages_bottle_idx").on(table.bottleId, table.id),
  check("messages_text_len", sql`length(${table.text}) between 1 and 500`),
]);

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 254 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  visitorId: varchar("visitor_id", { length: 64 }).notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true })
    .notNull()
    .default(sql`now() + interval '30 days'`),
}, (table) => [index("sessions_account_idx").on(table.accountId)]);

export const profiles = pgTable("profiles", {
  visitorId: varchar("visitor_id", { length: 64 }).primaryKey(),
  alias: varchar("alias", { length: 20 }).notNull(),
  publicId: uuid("public_id").notNull().unique().default(sql`gen_random_uuid()`),
  bio: varchar("bio", { length: 300 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("profiles_bio_len", sql`${table.bio} is null or length(${table.bio}) between 0 and 300`),
]);

export const photos = pgTable("photos", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  visitorId: varchar("visitor_id", { length: 64 })
    .notNull()
    .references(() => profiles.visitorId, { onDelete: "cascade" }),
  filename: varchar("filename", { length: 64 }).notNull().unique(),
  mime: varchar("mime", { length: 20 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("photos_visitor_idx").on(table.visitorId)]);

export type Bottle = typeof bottles.$inferSelect;

export const blocks = pgTable("blocks", {
  blockerId: varchar("blocker_id", { length: 64 }).notNull(),
  blockedId: varchar("blocked_id", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.blockerId, table.blockedId] }),
  check("blocks_no_self", sql`${table.blockerId} <> ${table.blockedId}`),
  index("blocks_blocked_idx").on(table.blockedId),
]);

export const reports = pgTable("reports", {
  id: serial("id").primaryKey(),
  reporterId: varchar("reporter_id", { length: 64 }).notNull(),
  reportedId: varchar("reported_id", { length: 64 }).notNull(),
  reason: varchar("reason", { length: 20 }).notNull(),
  text: varchar("text", { length: 500 }),
  bottleId: integer("bottle_id").references(() => bottles.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("reports_reason", sql`${table.reason} in ('acoso','spam','perfil_falso','otro')`),
  index("reports_reported_idx").on(table.reportedId),
]);

export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  visitorId: varchar("visitor_id", { length: 64 }).notNull(),
  type: varchar("type", { length: 20 }).notNull(),
  bottleId: integer("bottle_id").references(() => bottles.id, { onDelete: "set null" }),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check(
    "notifications_type",
    sql`${table.type} in ('botella_recogida','mensaje_nuevo','reserva_caducada')`,
  ),
  index("notifications_visitor_idx").on(table.visitorId, table.id),
]);
