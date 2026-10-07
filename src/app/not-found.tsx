/**
 * Root 404 boundary (i18n residual sweep): rendered by Next.js when no
 * route matches. Server components work here, so the dictionary resolves
 * normally from the locale cookie.
 */
import Link from "next/link";
import { getDictionary } from "@/i18n/server";

export default async function NotFound() {
  const t = (await getDictionary()).notFound;
  return (
    <main className="error-boundary">
      <h1 className="error-boundary-title">{t.title}</h1>
      <p className="error-boundary-body">{t.description}</p>
      <Link className="error-boundary-home" href="/overview">
        {t.back}
      </Link>
    </main>
  );
}
