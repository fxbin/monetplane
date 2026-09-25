import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "@/auth.config";
import { authenticateWithBootstrap } from "@/modules/team/service";

/**
 * Auth.js (NextAuth v5) configuration.
 *
 * Console authentication for the MonetPlane dashboard (#70): operators sign
 * in with their own durable email + password identity. The very first sign-in
 * on a fresh installation may claim the initial owner account with the
 * ADMIN_PASSWORD env value (bootstrap-on-first-login); afterwards the shared
 * password is inert and every operator uses their own credential.
 *
 * This is intentionally separate from the SDK Bearer token auth
 * (mp_app_* prefix) used by third-party applications on /api/* routes.
 *
 * Env vars (set in .env):
 *   AUTH_SECRET      — JWT signing secret (generate: openssl rand -base64 32)
 *   ADMIN_PASSWORD   — one-time bootstrap password for the first owner
 *
 * NOTE: role/permission authorization never trusts the JWT — the admin guard
 * re-reads membership from the database on every request (see
 * src/modules/admin/guard.ts).
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      name: "Workspace",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;

        try {
          const operator = await authenticateWithBootstrap({
            email,
            password,
          });
          if (!operator) return null;
          return {
            id: operator.operatorId,
            name: operator.name,
            email: operator.email,
            role: operator.role,
          };
        } catch (error) {
          console.error("[auth] sign-in failed:", error);
          return null;
        }
      },
    }),
  ],
});
