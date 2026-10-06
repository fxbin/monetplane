import { auth } from "@/auth";
import { getDictionary } from "@/i18n/server";
import { getConsoleContext } from "@/server/control-plane/context";
import { EnvironmentSwitcher } from "./EnvironmentSwitcher";
import { LocaleSwitcher } from "./LocaleSwitcher";

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
  const [session, context, dictionary] = await Promise.all([
    auth(),
    getConsoleContext(),
    getDictionary(),
  ]);
  const userName =
    session?.user?.name ?? session?.user?.email ?? dictionary.topbar.operator;
  const role = (
    (session?.user as { role?: string } | undefined)?.role ?? "operator"
  ).replace(/^./, (c) => c.toUpperCase());
  const applicationName =
    context.selectedApplication?.name ?? dictionary.topbar.noProject;

  return (
    <header className="topbar topbar-p1">
      <div className="topbar-left">
        <div className="topbar-context">
          <span className="topbar-context-label">
            {dictionary.topbar.environment}
          </span>
          <EnvironmentSwitcher
            applicationId={context.selectedApplication?.id ?? null}
            environment={context.environment}
            labels={dictionary.common}
          />
        </div>
        <span className="topbar-divider" aria-hidden="true" />
        <span className="topbar-scope-copy">{applicationName}</span>
      </div>
      <div className="topbar-right">
        <LocaleSwitcher />
        <div className="topbar-user-copy">
          <span className="topbar-user">{userName}</span>
          <span className="topbar-role">{role}</span>
        </div>
        <span className="topbar-avatar" aria-hidden="true">
          {initials(userName)}
        </span>
      </div>
    </header>
  );
}
