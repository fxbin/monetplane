/**
 * Workspace role and permission model (#70).
 *
 * The matrix is derived from the console actions that actually exist: every
 * sensitive admin mutation route is gated by exactly one permission, and the
 * guard checks the caller's role against this table on every request (fresh
 * from the database — never from the session token).
 *
 * `owner` and `admin` share the same permission set; owner-exclusive rules
 * (protecting owner members from demotion/removal, granting the owner role)
 * are enforced in the team service so an admin cannot manufacture owners.
 */

export const WORKSPACE_ROLES = [
  "owner",
  "admin",
  "developer",
  "support",
  "viewer",
] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * Permissions mirror the mutation surfaces of the admin control plane:
 * - applications:write  create/update applications, domains, branding
 * - catalog:write       products, prices, provider routing
 * - providers:write     connect/disconnect provider connections + credentials
 * - credentials:write   application server API keys (mp_app_*)
 * - billing:write       refunds, subscription cancellations, retries, reconcile
 * - credits:write       manual credit grants to application customers
 * - webhooks:write      developer webhook endpoints, rotation, delivery retry
 * - team:manage         invitations, membership roles/scope, removal
 */
export const TEAM_PERMISSIONS = [
  "applications:write",
  "catalog:write",
  "providers:write",
  "credentials:write",
  "billing:write",
  "credits:write",
  "webhooks:write",
  "team:manage",
] as const;

export type TeamPermission = (typeof TEAM_PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<WorkspaceRole, readonly TeamPermission[]> = {
  owner: TEAM_PERMISSIONS,
  admin: TEAM_PERMISSIONS,
  developer: [
    "applications:write",
    "catalog:write",
    "credentials:write",
    "webhooks:write",
  ],
  support: ["credits:write"],
  viewer: [],
};

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return (
    typeof value === "string" &&
    (WORKSPACE_ROLES as readonly string[]).includes(value)
  );
}

export function isTeamPermission(value: unknown): value is TeamPermission {
  return (
    typeof value === "string" &&
    (TEAM_PERMISSIONS as readonly string[]).includes(value)
  );
}

/** Pure role→permission check. Database-backed guards must go through the guard module. */
export function roleHasPermission(
  role: WorkspaceRole,
  permission: TeamPermission,
): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsForRole(
  role: WorkspaceRole,
): readonly TeamPermission[] {
  return ROLE_PERMISSIONS[role];
}

export const MEMBER_APPLICATION_SCOPES = ["all", "restricted"] as const;

export type MemberApplicationScope = (typeof MEMBER_APPLICATION_SCOPES)[number];

export function isMemberApplicationScope(
  value: unknown,
): value is MemberApplicationScope {
  return (
    typeof value === "string" &&
    (MEMBER_APPLICATION_SCOPES as readonly string[]).includes(value)
  );
}

/**
 * Human-facing permission matrix used by the team console and tests. Kept in
 * one place so the derived table can never drift from the enforcement table.
 */
export function permissionMatrix(): Record<
  WorkspaceRole,
  Record<TeamPermission, boolean>
> {
  const matrix = {} as Record<WorkspaceRole, Record<TeamPermission, boolean>>;
  for (const role of WORKSPACE_ROLES) {
    matrix[role] = {} as Record<TeamPermission, boolean>;
    for (const permission of TEAM_PERMISSIONS) {
      matrix[role][permission] = roleHasPermission(role, permission);
    }
  }
  return matrix;
}
