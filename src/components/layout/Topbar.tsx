import { auth } from "@/auth";
import { getConsoleContext } from "@/server/control-plane/context";
import { EnvironmentSwitcher } from "./EnvironmentSwitcher";

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
  const [session, context] = await Promise.all([auth(), getConsoleContext()]);
  const userName = session?.user?.name ?? session?.user?.email ?? "Admin";
  const applicationName = context.selectedApplication?.name ?? "No project";

  return (
    <header className="topbar topbar-p1">
      <div className="topbar-left">
        <div className="topbar-context">
          <span className="topbar-context-label">Environment</span>
          <EnvironmentSwitcher
            applicationId={context.selectedApplication?.id ?? null}
            environment={context.environment}
          />
        </div>
        <span className="topbar-divider" aria-hidden="true" />
        <span className="topbar-scope-copy">{applicationName}</span>
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
