import type { NextAuthConfig } from "next-auth";

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
  trustHost: true,
  providers: [],
  secret: process.env.AUTH_SECRET?.trim() || "build-placeholder-do-not-use",
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
      }
      return token;
    },
    async session({ session, token }) {
      if (token.sub) {
        (session.user as { id?: string }).id = token.sub;
      }
      (session.user as { role?: string }).role =
        (token.role as string | undefined) ?? "viewer";
      return session;
    },
  },
} satisfies NextAuthConfig;
