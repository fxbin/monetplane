import type { NextAuthConfig } from "next-auth";
import { getAuthSecret } from "./config/env";

/**
 * Edge-safe NextAuth base config (split from auth.ts, NextAuth v5 pattern).
 *
 * src/proxy.ts runs in the edge runtime and imports this file to decode the
 * session JWT only. Anything that touches the database or node:crypto lives
 * in src/auth.ts (Node runtime) so the proxy bundle stays free of it.
 *
 * Authorization is NEVER trusted from this token: role/membership are re-read
 * from the database by the admin guard on every request (#70 fail-closed).
 */
export const authConfig = {
  // Required behind proxies where the forwarded host differs from the
  // deployment host. Note this makes NextAuth trust the Host header for its
  // own callback URLs; the SDK/API surface applies its own stricter
  // application-domain checks (see src/modules/applications).
  trustHost: true,
  providers: [],
  // Fail fast: throws at module evaluation when AUTH_SECRET is missing or
  // empty. `next build` evaluates this module while collecting page data
  // (src/auth.ts is imported by pages/routes), so builds require the
  // variable to be set — there is intentionally no placeholder fallback.
  secret: getAuthSecret(),
  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 12, // 12 hours
  },
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = (user as { role?: string }).role ?? "viewer";
        // Captured at sign-in (external review 2026-10-06, P1-150-03):
        // the admin guard compares this against the operator's CURRENT
        // credentialVersion on every request, so rotating a password
        // invalidates all pre-existing JWTs immediately (the 12h maxAge
        // alone left a post-rotation window).
        token.credentialVersion = (
          user as { credentialVersion?: number }
        ).credentialVersion;
      }
      return token;
    },
    async session({ session, token }) {
      if (token.sub) {
        (session.user as { id?: string }).id = token.sub;
      }
      (session.user as { role?: string }).role =
        (token.role as string | undefined) ?? "viewer";
      (session.user as { credentialVersion?: number }).credentialVersion =
        token.credentialVersion as number | undefined;
      return session;
    },
  },
} satisfies NextAuthConfig;
