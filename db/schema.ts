import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const bottles = pgTable("bottles", {
  id: serial("id").primaryKey(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Bottle = typeof bottles.$inferSelect;
export type NewBottle = typeof bottles.$inferInsert;
