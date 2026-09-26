import { describe, expect, it } from "vitest";
import {
  isMemberApplicationScope,
  isTeamPermission,
  isWorkspaceRole,
  permissionMatrix,
  permissionsForRole,
  roleHasPermission,
  TEAM_PERMISSIONS,
  WORKSPACE_ROLES,
} from "../src/modules/team/permissions";

/**
 * Permission matrix tests (#70). The matrix is the single source of truth
 * enforced by the admin guard; these tests pin the intended policy so it
 * cannot drift silently.
 */

describe("workspace role permission matrix", () => {
  it("gives owner and admin every permission", () => {
    for (const role of ["owner", "admin"] as const) {
      for (const permission of TEAM_PERMISSIONS) {
        expect(
          roleHasPermission(role, permission),
          `${role} should hold ${permission}`,
        ).toBe(true);
      }
    }
  });

  it("developer manages build surfaces but never billing, providers, credits, or team", () => {
    const allowed = new Set([
      "applications:write",
      "catalog:write",
      "credentials:write",
      "webhooks:write",
    ]);
    for (const permission of TEAM_PERMISSIONS) {
      expect(roleHasPermission("developer", permission)).toBe(
        allowed.has(permission),
      );
    }
  });

  it("support can only grant customer credits", () => {
    for (const permission of TEAM_PERMISSIONS) {
      expect(roleHasPermission("support", permission)).toBe(
        permission === "credits:write",
      );
    }
  });

  it("viewer holds no write permissions", () => {
    for (const permission of TEAM_PERMISSIONS) {
      expect(roleHasPermission("viewer", permission)).toBe(false);
    }
  });

  it("exposes the derived matrix consistent with roleHasPermission", () => {
    const matrix = permissionMatrix();
    for (const role of WORKSPACE_ROLES) {
      for (const permission of TEAM_PERMISSIONS) {
        expect(matrix[role][permission]).toBe(
          roleHasPermission(role, permission),
        );
      }
    }
  });

  it("permissionsForRole returns exactly the permitted set", () => {
    expect(permissionsForRole("viewer")).toEqual([]);
    expect(permissionsForRole("support")).toEqual(["credits:write"]);
  });
});

describe("runtime validation helpers", () => {
  it("rejects values outside the role and permission catalogs", () => {
    expect(isWorkspaceRole("owner")).toBe(true);
    expect(isWorkspaceRole("superuser")).toBe(false);
    expect(isWorkspaceRole(null)).toBe(false);

    expect(isTeamPermission("billing:write")).toBe(true);
    expect(isTeamPermission("billing:read")).toBe(false);

    expect(isMemberApplicationScope("all")).toBe(true);
    expect(isMemberApplicationScope("none")).toBe(false);
  });

  it("never treats an unknown role as permitted", () => {
    for (const role of WORKSPACE_ROLES) {
      const matrix = permissionMatrix();
      const unknownPermissions = Object.keys(matrix[role]).filter(
        (permission) => !isTeamPermission(permission),
      );
      expect(unknownPermissions).toEqual([]);
    }
  });
});
