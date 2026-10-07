import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { getSessionActor } from "@/modules/admin/guard";
import "../console-shell.css";
import "../application-context.css";
import "../product-builder.css";
import "../product-routing.css";
import "../provider-connect.css";
import "../provider-diagnostics.css";
import "../customer-workspace.css";
import "../billing-operations.css";
import "../developer-tools.css";
import "../overview-analytics.css";
import "../team.css";

/**
 * DB-backed actor gate (external review round-2, P1): the proxy only
 * checks that a JWT exists — it cannot see credentialVersion. A stale
 * token (post password-rotation) previously slipped past the proxy and
 * read dashboard data through server components that call
 * getConsoleContext() directly, without the admin API guard. The layout
 * now re-validates the actor against the database (which includes the
 * credentialVersion fail-closed check) before rendering any dashboard
 * subtree. getConsoleContext's "no session → no narrowing" fallback
 * remains for direct control-plane callers in tests only.
 */
export default async function DashboardLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const actor = await getSessionActor();
  if (!actor) redirect("/login");

  return (
    <div className="dashboard-shell">
      <Sidebar />
      <div className="dashboard-main">
        <Topbar />
        <main className="dashboard-content">{children}</main>
      </div>
    </div>
  );
}
