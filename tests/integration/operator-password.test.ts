import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as passwordPOST } from "../../src/app/api/admin/session/password/route";
import { getDb } from "../../src/db/client";
import { operators } from "../../src/modules/team/schema";
import {
  acceptInvitation,
  changeOperatorPassword,
  findMembershipByEmail,
  inviteMember,
} from "../../src/modules/team/service";
import { setupIntegrationFile } from "./test-setup";

/**
 * Operator self-service password change (roundtable 2026-10-06, PR1).
 * NextAuth session mocked (team-access pattern); membership data real.
 */
vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
  headers: vi.fn(),
  draftMode: vi.fn(),
}));

const { auth } = await import("@/auth");
const mockAuth = vi.mocked(auth);
const { cookies } = await import("next/headers");
const mockCookies = vi.mocked(cookies);

const _db = getDb();
setupIntegrationFile();

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedOperator(seed: string) {
  const email = `pw-${seed}@example.test`;
  const { token } = await inviteMember({
    email,
    role: "owner",
    applicationScope: "all",
    applicationIds: [],
    invitedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
  });
  await acceptInvitation({
    token,
    name: "PW Operator",
    password: "current(s3cret)1",
  });
  const membership = await findMembershipByEmail(email);
  if (!membership) throw new Error("membership missing");
  mockAuth.mockResolvedValue({
    user: { id: membership.operatorId, credentialVersion: 0 },
    expires: new Date(Date.now() + 3600_000).toISOString(),
  } as never);
  mockCookies.mockResolvedValue({ get: () => undefined } as never);
  return membership;
}

function postPassword(body: Record<string, unknown>): Promise<Response> {
  return passwordPOST(
    new Request("https://console.test/api/admin/session/password", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("operator password self-service", () => {
  it("changes the password after verifying the current one", async () => {
    const m = await seedOperator(Math.random().toString(36).slice(2, 8));
    const response = await postPassword({
      currentPassword: "current(s3cret)1",
      newPassword: "new(s3cret)2",
    });
    expect(response.status).toBe(200);

    // The new password verifies against the stored hash.
    await expect(
      changeOperatorPassword({
        operatorId: m.operatorId,
        currentPassword: "new(s3cret)2",
        newPassword: "next(s3cret)3",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a wrong current password with 401", async () => {
    await seedOperator(Math.random().toString(36).slice(2, 8));
    const response = await postPassword({
      currentPassword: "wrong-password",
      newPassword: "new(s3cret)2",
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("Current password is incorrect");
  });

  it("rejects a too-short new password", async () => {
    await seedOperator(Math.random().toString(36).slice(2, 8));
    const response = await postPassword({
      currentPassword: "current(s3cret)1",
      newPassword: "short",
    });
    expect(response.status).toBe(400);
  });
});

describe("password self-service hardening (external review)", () => {
  it("is available to non-team-manager members (P1-150-01)", async () => {
    const email = `pw-viewer-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const { inviteMember, acceptInvitation, findMembershipByEmail } =
      await import("../../src/modules/team/service");
    const { token } = await inviteMember({
      email,
      role: "viewer",
      applicationScope: "all",
      applicationIds: [],
      invitedBy: { operatorId: "op_owner", role: "owner", label: "Owner" },
    });
    await acceptInvitation({
      token,
      name: "Viewer Op",
      password: "viewer(s3cret)1",
    });
    const membership = await findMembershipByEmail(email);
    if (!membership) throw new Error("membership missing");
    mockAuth.mockResolvedValue({
      // credentialVersion 0 matches the DB row at creation (fail-closed
      // guard requires a safe-integer version that equals the DB value).
      user: { id: membership.operatorId, credentialVersion: 0 },
      expires: new Date(Date.now() + 3600_000).toISOString(),
    } as never);

    const response = await postPassword({
      currentPassword: "viewer(s3cret)1",
      newPassword: "viewer(s3cret)2",
    });
    expect(response.status).toBe(200);
  });

  it("hits the CAS loser path: an UPDATE armed with the OLD hash matches 0 rows after the winner commits (round-2)", async () => {
    const m = await seedOperator(Math.random().toString(36).slice(2, 8));

    // What a concurrent request would have read + verified against.
    const [before] = await getDb()
      .select({ passwordHash: operators.passwordHash })
      .from(operators)
      .where(eq(operators.id, m.operatorId))
      .limit(1);
    expect(before).toBeTruthy();

    // Winner commits.
    await changeOperatorPassword({
      operatorId: m.operatorId,
      currentPassword: "current(s3cret)1",
      newPassword: "rotated(s3cret)1",
    });

    // Loser: the CAS WHERE clause (same shape the service uses) matches
    // 0 rows against the stale hash — the loser cannot win.
    const loser = await getDb()
      .update(operators)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(operators.id, m.operatorId),
          eq(operators.passwordHash, before?.passwordHash ?? ""),
        ),
      )
      .returning({ id: operators.id });
    expect(loser).toHaveLength(0);
  });

  it("bumps credentialVersion so a stale session is rejected by the guard (P1-150-03)", async () => {
    const m = await seedOperator(Math.random().toString(36).slice(2, 8));
    const { changeOperatorPassword } = await import(
      "../../src/modules/team/service"
    );
    const { findMembershipByOperatorId } = await import(
      "../../src/modules/team/service"
    );
    const before = await findMembershipByOperatorId(m.operatorId);
    await changeOperatorPassword({
      operatorId: m.operatorId,
      currentPassword: "current(s3cret)1",
      newPassword: "rotated(s3cret)1",
    });
    const after = await findMembershipByOperatorId(m.operatorId);
    expect(after?.operatorCredentialVersion).toBe(
      (before?.operatorCredentialVersion ?? 0) + 1,
    );
  });

  // Round-3 (external review): the guard is fail-closed on the version
  // claim — all three states exercised end-to-end through the route.
  it("credentialVersion gate: unversioned session → 401, stale version → 401, current version → allowed", async () => {
    const m = await seedOperator(Math.random().toString(36).slice(2, 8));
    const { findMembershipByOperatorId } = await import(
      "../../src/modules/team/service"
    );

    // Rotate: DB version moves 0 → 1. The mock session (seeded at version
    // 0) is now stale by construction.
    await changeOperatorPassword({
      operatorId: m.operatorId,
      currentPassword: "current(s3cret)1",
      newPassword: "rotated(s3cret)1",
    });
    const membership = await findMembershipByOperatorId(m.operatorId);
    const currentVersion = membership?.operatorCredentialVersion ?? 1;

    const post = () =>
      passwordPOST(
        new Request("https://console.test/api/admin/session/password", {
          method: "POST",
          body: JSON.stringify({
            currentPassword: "rotated(s3cret)1",
            newPassword: "next(s3cret)2",
          }),
          headers: { "content-type": "application/json" },
        }),
      );

    // State 1: unversioned legacy session (no credentialVersion claim)
    // — fail-closed, NOT a silent skip.
    mockAuth.mockResolvedValue({
      user: { id: m.operatorId },
      expires: new Date(Date.now() + 3600_000).toISOString(),
    } as never);
    expect((await post()).status).toBe(401);

    // State 2: versioned session captured before the rotation (stale).
    mockAuth.mockResolvedValue({
      user: { id: m.operatorId, credentialVersion: currentVersion - 1 },
      expires: new Date(Date.now() + 3600_000).toISOString(),
    } as never);
    expect((await post()).status).toBe(401);

    // State 3: session re-issued after the rotation (current version)
    // — passes the gate and the request succeeds end-to-end.
    mockAuth.mockResolvedValue({
      user: { id: m.operatorId, credentialVersion: currentVersion },
      expires: new Date(Date.now() + 3600_000).toISOString(),
    } as never);
    expect((await post()).status).toBe(200);
  });
});
