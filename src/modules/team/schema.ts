import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { applications } from "../applications/schema";
import { MEMBER_APPLICATION_SCOPES, WORKSPACE_ROLES } from "./permissions";

/**
 * Console team workspace (#70).
 *
 * One deployment is one workspace. `operators` are durable human identities;
 * `workspace_members` bind an operator to exactly one membership with a role
 * and an optional restricted application scope. SDK application credentials
 * (mp_app_*) stay a fully separate machine-to-machine system — these tables
 * never authenticate /api/* SDK traffic.
 */

export const operators = pgTable(
  "operators",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("operators_email_unique").on(table.email),
    check(
      "operators_status_check",
      sql`${table.status} IN ('active', 'disabled')`,
    ),
  ],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: text("id").primaryKey(),
    operatorId: text("operator_id")
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    applicationScope: text("application_scope").notNull().default("all"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("workspace_members_operator_unique").on(table.operatorId),
    check(
      "workspace_members_role_check",
      sql`${table.role} IN (${sql.join(
        WORKSPACE_ROLES.map((role) => sql`${role}`),
        sql`, `,
      )})`,
    ),
    check(
      "workspace_members_scope_check",
      sql`${table.applicationScope} IN (${sql.join(
        MEMBER_APPLICATION_SCOPES.map((scope) => sql`${scope}`),
        sql`, `,
      )})`,
    ),
  ],
);

export const memberApplicationAccess = pgTable(
  "member_application_access",
  {
    memberId: text("member_id")
      .notNull()
      .references(() => workspaceMembers.id, { onDelete: "cascade" }),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.memberId, table.applicationId] }),
    index("member_access_application_idx").on(table.applicationId),
  ],
);

export const operatorInvitations = pgTable(
  "operator_invitations",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    role: text("role").notNull(),
    applicationScope: text("application_scope").notNull().default("all"),
    applicationIds: jsonb("application_ids")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("pending"),
    invitedBy: text("invited_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("operator_invitations_token_unique").on(table.tokenHash),
    index("operator_invitations_email_idx").on(table.email),
    check(
      "operator_invitations_role_check",
      sql`${table.role} IN (${sql.join(
        WORKSPACE_ROLES.map((role) => sql`${role}`),
        sql`, `,
      )})`,
    ),
    check(
      "operator_invitations_scope_check",
      sql`${table.applicationScope} IN (${sql.join(
        MEMBER_APPLICATION_SCOPES.map((scope) => sql`${scope}`),
        sql`, `,
      )})`,
    ),
    check(
      "operator_invitations_status_check",
      sql`${table.status} IN ('pending', 'accepted', 'revoked')`,
    ),
  ],
);
