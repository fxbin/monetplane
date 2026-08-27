import { auth } from "@/auth";

export async function Topbar() {
  const session = await auth();
  const userName = session?.user?.name ?? "Admin";

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="topbar-env-badge">Production</span>
      </div>
      <div className="topbar-right">
        <span className="topbar-user">{userName}</span>
      </div>
    </header>
  );
}
