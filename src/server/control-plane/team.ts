import { redirect } from "next/navigation";
import { getSessionActor } from "@/modules/admin/guard";
import {
  permissionMatrix,
  roleHasPermission,
} from "@/modules/team/permissions";
import { listTeamOverview } from "@/modules/team/service";
import { getApplicationList } from "@/server/control-plane/console-queries";

/**
 * Console team workspace page data (#70). Server-side authorization: members
 * without team:manage never reach the page (the API guard is the boundary,
 * this keeps the page from rendering for them at all).
 */
export async function getTeamPageData() {
  const actor = await getSessionActor();
  if (!actor) redirect("/login");
  if (!roleHasPermission(actor.role, "team:manage")) redirect("/overview");

  const [team, applications] = await Promise.all([
    listTeamOverview(),
    getApplicationList(),
  ]);

  return {
    actor,
    members: team.members,
    invitations: team.invitations,
    applications: applications.map((application) => ({
      id: application.id,
      name: application.name,
      slug: application.slug,
    })),
    matrix: permissionMatrix(),
  };
}
