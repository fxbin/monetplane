import { PageContainer } from "@/components/layout/PageContainer";
import { TeamManager } from "@/components/team/TeamManager";
import { getTeamPageData } from "@/server/control-plane/team";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const data = await getTeamPageData();

  return (
    <PageContainer
      title="Team"
      description="Workspace operators, their console roles, and project access scopes. Every change is recorded in the audit log."
    >
      <TeamManager
        viewer={{ operatorId: data.actor.operatorId, role: data.actor.role }}
        members={data.members}
        invitations={data.invitations}
        applications={data.applications}
        matrix={data.matrix}
      />
    </PageContainer>
  );
}
