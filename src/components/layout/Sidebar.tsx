import { getSessionActor } from "@/modules/admin/guard";
import { roleHasPermission } from "@/modules/team/permissions";
import { getConsoleContext } from "@/server/control-plane/context";
import { SidebarNavigation } from "./SidebarNavigation";

export async function Sidebar() {
  const [context, actor] = await Promise.all([
    getConsoleContext(),
    getSessionActor(),
  ]);

  return (
    <SidebarNavigation
      applications={context.applications}
      selectedApplicationId={context.selectedApplication?.id ?? null}
      environment={context.environment}
      canManageTeam={
        actor ? roleHasPermission(actor.role, "team:manage") : false
      }
    />
  );
}
