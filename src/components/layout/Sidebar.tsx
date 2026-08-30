import { getConsoleContext } from "@/server/control-plane/context";
import { SidebarNavigation } from "./SidebarNavigation";

export async function Sidebar() {
  const context = await getConsoleContext();

  return (
    <SidebarNavigation
      applications={context.applications}
      selectedApplicationId={context.selectedApplication?.id ?? null}
      environment={context.environment}
    />
  );
}
