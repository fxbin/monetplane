import { auth } from "@/auth";

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "MP"
  );
}

export async function Topbar() {
  const session = await auth();
  const userName = session?.user?.name ?? session?.user?.email ?? "Admin";

  return (
    <header className="topbar topbar-p1">
      <div className="topbar-left">
        <div className="topbar-context">
          <span className="topbar-context-label">Environment</span>
          <span className="topbar-env-badge topbar-env-live">
            <span className="topbar-env-dot" />
            Production
          </span>
        </div>
        <span className="topbar-divider" aria-hidden="true" />
        <span className="topbar-scope-copy">All application data</span>
      </div>
      <div className="topbar-right">
        <div className="topbar-user-copy">
          <span className="topbar-user">{userName}</span>
          <span className="topbar-role">Operator</span>
        </div>
        <span className="topbar-avatar" aria-hidden="true">
          {initials(userName)}
        </span>
      </div>
    </header>
  );
}
