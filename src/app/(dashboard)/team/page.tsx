import { PageContainer } from "@/components/layout/PageContainer";
import { TeamManager } from "@/components/team/TeamManager";
import { getDictionary } from "@/i18n/server";
import { getTeamPageData } from "@/server/control-plane/team";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const [data, dictionary] = await Promise.all([
    getTeamPageData(),
    getDictionary(),
  ]);

  return (
    <PageContainer
      title={dictionary.team.title}
      description={dictionary.team.description}
    >
      <TeamManager
        viewer={{ operatorId: data.actor.operatorId, role: data.actor.role }}
        members={data.members}
        invitations={data.invitations}
        applications={data.applications}
        matrix={data.matrix}
        labels={dictionary.team}
      />
    </PageContainer>
  );
}
