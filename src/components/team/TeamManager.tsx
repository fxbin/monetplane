"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { StatusBadge } from "@/components/ui/console";

type WorkspaceRole = "owner" | "admin" | "developer" | "support" | "viewer";

type Member = {
  memberId: string;
  operatorId: string;
  operatorEmail: string;
  operatorName: string;
  operatorStatus: string;
  role: WorkspaceRole;
  applicationScope: "all" | "restricted";
  applicationIds: string[];
  lastLoginAt: string | Date | null;
};

type Invitation = {
  id: string;
  email: string;
  role: WorkspaceRole;
  applicationScope: string;
};

type ApplicationOption = { id: string; name: string; slug: string };

type TeamManagerProps = {
  viewer: { operatorId: string; role: WorkspaceRole };
  members: Member[];
  invitations: Invitation[];
  applications: ApplicationOption[];
  matrix: Record<WorkspaceRole, Record<string, boolean>>;
};

const ROLES: WorkspaceRole[] = [
  "owner",
  "admin",
  "developer",
  "support",
  "viewer",
];

const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  owner: "Full access, including managing owner members",
  admin: "Full console access, cannot manage owner members",
  developer: "Projects, catalog, API keys, webhooks",
  support: "Read access and customer credit grants",
  viewer: "Read-only console access",
};

export function TeamManager({
  viewer,
  members,
  invitations,
  applications,
  matrix,
}: TeamManagerProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isOwner = viewer.role === "owner";
  const canManageTarget = (member: Member) =>
    member.operatorId !== viewer.operatorId &&
    (isOwner || member.role !== "owner");

  async function request(path: string, init: RequestInit) {
    setError(null);
    setNotice(null);
    const response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        typeof body.error === "string" ? body.error : "Request failed",
      );
    }
    return body;
  }

  async function changeRole(member: Member, role: WorkspaceRole) {
    setBusy(`role:${member.memberId}`);
    try {
      await request(`/api/admin/team/members/${member.memberId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      setNotice(`${member.operatorEmail} is now ${role}`);
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to change role",
      );
    } finally {
      setBusy(null);
    }
  }

  async function changeScope(
    member: Member,
    scope: "all" | "restricted",
    applicationIds: string[],
  ) {
    setBusy(`scope:${member.memberId}`);
    try {
      await request(`/api/admin/team/members/${member.memberId}`, {
        method: "PATCH",
        body: JSON.stringify({ applicationScope: scope, applicationIds }),
      });
      setNotice(`Access scope updated for ${member.operatorEmail}`);
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to update scope",
      );
    } finally {
      setBusy(null);
    }
  }

  async function removeMember(member: Member) {
    if (
      !window.confirm(
        `Remove ${member.operatorEmail} from the workspace? Their console access is revoked immediately.`,
      )
    ) {
      return;
    }
    setBusy(`remove:${member.memberId}`);
    try {
      await request(`/api/admin/team/members/${member.memberId}`, {
        method: "DELETE",
      });
      setNotice(`${member.operatorEmail} removed`);
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to remove member",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="team-manager">
      {error && <p className="form-error">{error}</p>}
      {notice && <p className="team-notice">{notice}</p>}

      <section className="card">
        <h2 className="card-title">Members</h2>
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Operator</th>
                <th>Role</th>
                <th>Project access</th>
                <th>Last sign-in</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const manageable = canManageTarget(member);
                return (
                  <tr key={member.memberId}>
                    <td>
                      <div className="team-operator">
                        <span className="team-operator-name">
                          {member.operatorName}
                        </span>
                        <span className="cell-muted">
                          {member.operatorEmail}
                          {member.operatorId === viewer.operatorId
                            ? " · you"
                            : ""}
                        </span>
                      </div>
                    </td>
                    <td>
                      {manageable ? (
                        <select
                          aria-label={`Role for ${member.operatorEmail}`}
                          value={member.role}
                          disabled={busy === `role:${member.memberId}`}
                          onChange={(event) =>
                            changeRole(
                              member,
                              event.target.value as WorkspaceRole,
                            )
                          }
                        >
                          {ROLES.filter(
                            (role) => isOwner || role !== "owner",
                          ).map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="cell-mono">{member.role}</span>
                      )}
                    </td>
                    <td>
                      {manageable ? (
                        <ScopeEditor
                          member={member}
                          applications={applications}
                          busy={busy === `scope:${member.memberId}`}
                          onChange={changeScope}
                        />
                      ) : (
                        <span className="cell-muted">
                          {member.applicationScope === "all"
                            ? "All projects"
                            : `${member.applicationIds.length} project(s)`}
                        </span>
                      )}
                    </td>
                    <td className="cell-muted">
                      {member.lastLoginAt
                        ? new Date(member.lastLoginAt).toLocaleString()
                        : "—"}
                    </td>
                    <td>
                      <StatusBadge status={member.operatorStatus} />
                    </td>
                    <td>
                      {manageable ? (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={busy === `remove:${member.memberId}`}
                          onClick={() => removeMember(member)}
                        >
                          Remove
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Pending invitations</h2>
        {invitations.length === 0 ? (
          <p className="cell-muted">No pending invitations.</p>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Scope</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {invitations.map((invitation) => (
                  <tr key={invitation.id}>
                    <td>{invitation.email}</td>
                    <td className="cell-mono">{invitation.role}</td>
                    <td className="cell-muted">
                      {invitation.applicationScope}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy === `revoke:${invitation.id}`}
                        onClick={async () => {
                          setBusy(`revoke:${invitation.id}`);
                          try {
                            await request(
                              `/api/admin/team/invitations/${invitation.id}`,
                              { method: "DELETE" },
                            );
                            router.refresh();
                          } catch (cause) {
                            setError(
                              cause instanceof Error
                                ? cause.message
                                : "Failed to revoke",
                            );
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <InviteForm applications={applications} isOwner={isOwner} />

      <section className="card">
        <h2 className="card-title">Permission matrix</h2>
        <p className="cell-muted">
          Backend-enforced on every admin API call; the console only mirrors it.
        </p>
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Permission</th>
                {ROLES.map((role) => (
                  <th key={role}>{role}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.keys(matrix.owner ?? {}).map((permission) => (
                <tr key={permission}>
                  <td className="cell-mono">{permission}</td>
                  {ROLES.map((role) => (
                    <td key={role}>{matrix[role]?.[permission] ? "✓" : "—"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ScopeEditor({
  member,
  applications,
  busy,
  onChange,
}: {
  member: Member;
  applications: ApplicationOption[];
  busy: boolean;
  onChange: (
    member: Member,
    scope: "all" | "restricted",
    applicationIds: string[],
  ) => void;
}) {
  const selected = new Set(member.applicationIds);
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => setEditing(true)}
      >
        {member.applicationScope === "all"
          ? "All projects"
          : `${member.applicationIds.length} project(s)`}
      </button>
    );
  }

  return (
    <div className="team-scope-editor">
      <label className="team-scope-option">
        <input
          type="radio"
          name={`scope-${member.memberId}`}
          defaultChecked={member.applicationScope === "all"}
          onChange={() => onChange(member, "all", [])}
        />
        All projects
      </label>
      <div className="team-scope-option">
        <span>Restricted to:</span>
        {applications.length === 0 ? (
          <span className="cell-muted">No projects yet</span>
        ) : (
          <div className="team-scope-list">
            {applications.map((application) => (
              <label key={application.id}>
                <input
                  type="checkbox"
                  defaultChecked={selected.has(application.id)}
                  data-app-id={application.id}
                  data-scope-for={member.memberId}
                />
                {application.name}
              </label>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={(event) => {
          const checkboxes = Array.from(
            (
              event.currentTarget.closest(".team-scope-editor") as HTMLElement
            ).querySelectorAll("input[data-app-id]"),
          ) as HTMLInputElement[];
          const ids = checkboxes
            .filter((input) => input.checked)
            .map((input) => input.dataset.appId as string);
          onChange(member, "restricted", ids);
          setEditing(false);
        }}
      >
        Save scope
      </button>
    </div>
  );
}

function InviteForm({
  applications,
  isOwner,
}: {
  applications: ApplicationOption[];
  isOwner: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("viewer");
  const [scope, setScope] = useState<"all" | "restricted">("all");
  const [selectedApps, setSelectedApps] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setInviteUrl(null);
    try {
      const response = await fetch("/api/admin/team/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          role,
          applicationScope: scope,
          applicationIds: scope === "restricted" ? selectedApps : [],
        }),
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(
          typeof body.error === "string" ? body.error : "Invite failed",
        );
      }
      setInviteUrl(String(body.inviteUrl));
      setEmail("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invite failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="card-title">Invite an operator</h2>
      <form className="team-invite-form" onSubmit={submit}>
        <label>
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="operator@yourcompany.com"
            required
          />
        </label>
        <label>
          <span>Role</span>
          <select
            value={role}
            title={ROLE_DESCRIPTIONS[role]}
            onChange={(event) => setRole(event.target.value as WorkspaceRole)}
          >
            {ROLES.filter((candidate) => isOwner || candidate !== "owner").map(
              (candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          <span>Project access</span>
          <select
            value={scope}
            onChange={(event) =>
              setScope(event.target.value as "all" | "restricted")
            }
          >
            <option value="all">All projects</option>
            <option value="restricted">Restricted selection</option>
          </select>
        </label>
        {scope === "restricted" && (
          <div className="team-scope-list">
            {applications.map((application) => (
              <label key={application.id}>
                <input
                  type="checkbox"
                  checked={selectedApps.includes(application.id)}
                  onChange={(event) =>
                    setSelectedApps((current) =>
                      event.target.checked
                        ? [...current, application.id]
                        : current.filter((id) => id !== application.id),
                    )
                  }
                />
                {application.name}
              </label>
            ))}
          </div>
        )}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Inviting…" : "Create invitation"}
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
      {inviteUrl && (
        <div className="team-invite-result">
          <p>
            Share this single-use sign-up link (shown once, valid for 7 days):
          </p>
          <code className="cell-mono">{inviteUrl}</code>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigator.clipboard.writeText(inviteUrl)}
          >
            Copy link
          </button>
        </div>
      )}
    </section>
  );
}
