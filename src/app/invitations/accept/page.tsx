import { AcceptInvitationForm } from "@/components/team/AcceptInvitationForm";

export const dynamic = "force-dynamic";

export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <h1 className="login-title">Join the workspace</h1>
          <p className="login-subtitle">
            Set your sign-in credentials to accept this MonetPlane invitation.
          </p>
        </div>
        <AcceptInvitationForm token={token} />
      </div>
    </div>
  );
}
