import { NextResponse } from "next/server";
import { auth } from "@/auth";

/**
 * NextAuth middleware — protects dashboard routes.
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

export default auth((req) => {
  const { pathname } = req.nextUrl;

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

  return NextResponse.next();
});

export const config = {
  // Match all paths except static assets and Next internals
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|css|js|map)$).*)",
  ],
};
