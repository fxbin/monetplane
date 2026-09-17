import { NextResponse } from "next/server";
import { auth } from "@/auth";

/**
 * NextAuth proxy (Next.js 16 convention, formerly middleware) — protects
 * dashboard routes.
 *
 * Routes that require admin session:
 * - /overview, /products, /providers, /customers (dashboard pages)
 *
 * Routes that are public:
 * - /login (the sign-in page itself)
 * - /api/* (SDK Bearer auth handles its own security)
 * - /api/auth/* (NextAuth callback endpoints)
 */

const PROTECTED_PATHS = ["/overview", "/products", "/providers", "/customers"];

const PUBLIC_PATHS = ["/login", "/api/auth"];

function isProtected(path: string): boolean {
  return PROTECTED_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Bounded single-instance abuse protection for sensitive admin mutations:
 * sliding-window counter per admin session (documented limitation — no
 * distributed infrastructure by design, see #66 non-goals).
 */
const ADMIN_MUTATION_LIMIT = 120; // per window
const ADMIN_MUTATION_WINDOW_MS = 60_000;
const adminMutationWindows = new Map<
  string,
  { count: number; resetAt: number }
>();

function adminMutationAllowed(key: string): boolean {
  const now = Date.now();
  const window = adminMutationWindows.get(key);
  if (!window || window.resetAt <= now) {
    adminMutationWindows.set(key, {
      count: 1,
      resetAt: now + ADMIN_MUTATION_WINDOW_MS,
    });
    return true;
  }
  window.count += 1;
  return window.count <= ADMIN_MUTATION_LIMIT;
}

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();

  if (pathname.startsWith("/api/admin/") && method !== "GET" && req.auth) {
    const actorKey = (req.auth.user?.id ??
      req.auth.user?.email ??
      "admin") as string;
    if (!adminMutationAllowed(actorKey)) {
      return NextResponse.json(
        { error: "Too many operations, slow down", code: "rate_limited" },
        { status: 429 },
      );
    }
  }

  // Allow NextAuth endpoints and login page
  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  // Protect dashboard pages
  if (isProtected(pathname)) {
    if (!req.auth) {
      const loginUrl = new URL("/login", req.nextUrl.origin);
      loginUrl.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  // Root redirect to overview (only if authenticated)
  if (pathname === "/") {
    if (req.auth) {
      return NextResponse.redirect(new URL("/overview", req.nextUrl.origin));
    }
    const loginUrl = new URL("/login", req.nextUrl.origin);
    return NextResponse.redirect(loginUrl);
  }

  const response = NextResponse.next();
  const correlationId = req.headers.get("x-monetplane-request-id");
  if (correlationId && /^[\w.-]{8,128}$/.test(correlationId)) {
    response.headers.set("x-monetplane-request-id", correlationId);
  }
  return response;
});

export const config = {
  // Match all paths except static assets and Next internals
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|css|js|map)$).*)",
  ],
};
