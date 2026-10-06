import { AcceptInvitationForm } from "@/components/team/AcceptInvitationForm";
import { getDictionary } from "@/i18n/server";

export const dynamic = "force-dynamic";

export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [params, dictionary] = await Promise.all([
    searchParams,
    getDictionary(),
  ]);
  const token = typeof params.token === "string" ? params.token : "";

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <h1 className="login-title">{dictionary.invitations.title}</h1>
          <p className="login-subtitle">{dictionary.invitations.subtitle}</p>
        </div>
        <AcceptInvitationForm
          token={token}
          labels={dictionary.acceptInvitation}
        />
      </div>
    </div>
  );
}
