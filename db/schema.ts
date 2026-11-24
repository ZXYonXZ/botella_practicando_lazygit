import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
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
  visitorId: varchar("visitor_id", { length: 64 }).notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type Bottle = typeof bottles.$inferSelect;

export const profiles = pgTable("profiles", {
  visitorId: varchar("visitor_id", { length: 64 }).primaryKey(),
  alias: varchar("alias", { length: 20 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
