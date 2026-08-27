import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

/**
 * Auth.js (NextAuth v5) configuration.
 *
 * Admin-only authentication for the MonetPlane dashboard.
 * Uses JWT sessions (no database adapter needed) and a single
 * shared admin credential sourced from ADMIN_PASSWORD env var.
 *
 * This is intentionally separate from the SDK Bearer token auth
 * (mp_app_* prefix) used by third-party applications on /api/* routes.
 *
 * Env vars (set in .env):
 *   AUTH_SECRET     — JWT signing secret (generate: openssl rand -base64 32)
 *   ADMIN_PASSWORD  — shared admin login password
 */

function getAdminPassword(): string {
  const value = process.env.ADMIN_PASSWORD?.trim();
  if (!value) {
    throw new Error(
      "ADMIN_PASSWORD is required for dashboard admin login. Set it in .env",
    );
  }
  return value;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  secret: process.env.AUTH_SECRET?.trim() || "build-placeholder-do-not-use",
  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 12, // 12 hours
  },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      name: "Admin",
      credentials: {
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const password = credentials?.password as string | undefined;
        if (!password) return null;

        const adminPassword = getAdminPassword();
        if (password !== adminPassword) return null;

        return {
          id: "admin",
          name: "Admin",
          email: "admin@monetplane.local",
          role: "admin",
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = (user as { role?: string }).role ?? "admin";
      }
      return token;
    },
    async session({ session, token }) {
      if (token.sub) {
        (session.user as { id?: string }).id = token.sub;
      }
      (session.user as { role?: string }).role =
        (token.role as string | undefined) ?? "admin";
      return session;
    },
  },
});

/**
 * Check if a request has a valid admin session.
 * Returns the session object if authenticated, null otherwise.
 *
 * Usage in Admin API route handlers:
 * ```ts
 * import { requireAdminSession } from "@/auth";
 * const session = await requireAdminSession();
 * ```
 */
export async function requireAdminSession() {
  const session = await auth();
  if (!session?.user) return null;
  return session;
}
