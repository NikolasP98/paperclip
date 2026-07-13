import { pgTable, uuid, text, jsonb, integer, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const pipelines = pgTable(
  "pipelines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    executionMode: text("execution_mode").notNull().default("inline"),
    trigger: jsonb("trigger").$type<Record<string, unknown>>(),
    steps: jsonb("steps").$type<Array<Record<string, unknown>>>().notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("pipelines_company_idx").on(table.companyId),
    projectIdx: index("pipelines_company_project_idx").on(table.companyId, table.projectId),
  }),
);
