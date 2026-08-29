import { getApplicationList } from "@/modules/admin/queries";
import { SidebarNavigation } from "./SidebarNavigation";

export async function Sidebar() {
  const applications = await getApplicationList();

  return <SidebarNavigation applications={applications} />;
}
