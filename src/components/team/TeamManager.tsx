"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { StatusBadge } from "@/components/ui/console";
import type { Dictionary } from "@/i18n/dictionaries/en";
import { formatMessage } from "@/i18n/format";

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
  /** Locale-resolved labels (client components receive dictionary slices). */
  labels: Dictionary["team"];
};

const ROLES: WorkspaceRole[] = [
  "owner",
  "admin",
  "developer",
  "support",
  "viewer",
];

export function TeamManager({
  viewer,
  members,
  invitations,
  applications,
  matrix,
  labels,
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
        typeof body.error === "string" ? body.error : labels.requestFailed,
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
      setNotice(
        formatMessage(labels.roleChangedNotice, {
          email: member.operatorEmail,
          role,
        }),
      );
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.failedRole);
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
      setNotice(
        formatMessage(labels.scopeUpdatedNotice, {
          email: member.operatorEmail,
        }),
      );
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.failedScope);
    } finally {
      setBusy(null);
    }
  }

  async function removeMember(member: Member) {
    if (
      !window.confirm(
        formatMessage(labels.removeConfirm, { email: member.operatorEmail }),
      )
    ) {
      return;
    }
    setBusy(`remove:${member.memberId}`);
    try {
      await request(`/api/admin/team/members/${member.memberId}`, {
        method: "DELETE",
      });
      setNotice(
        formatMessage(labels.removedNotice, { email: member.operatorEmail }),
      );
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.failedRemove);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="team-manager">
      {error && <p className="form-error">{error}</p>}
      {notice && <p className="team-notice">{notice}</p>}

      <section className="card">
        <h2 className="card-title">{labels.members}</h2>
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>{labels.thOperator}</th>
                <th>{labels.thRole}</th>
                <th>{labels.thProjectAccess}</th>
                <th>{labels.thLastSignIn}</th>
                <th>{labels.thStatus}</th>
                <th aria-label={labels.thActions} />
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
                            ? labels.you
                            : ""}
                        </span>
                      </div>
                    </td>
                    <td>
                      {manageable ? (
                        <select
                          className="form-input"
                          aria-label={formatMessage(labels.roleFor, {
                            email: member.operatorEmail,
                          })}
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
                          labels={labels}
                        />
                      ) : (
                        <span className="cell-muted">
                          {member.applicationScope === "all"
                            ? labels.allProjects
                            : formatMessage(labels.projectsCount, {
                                count: String(member.applicationIds.length),
                              })}
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
                          {labels.remove}
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
        <h2 className="card-title">{labels.pendingInvitations}</h2>
        {invitations.length === 0 ? (
          <p className="cell-muted">{labels.noInvitations}</p>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{labels.thEmail}</th>
                  <th>{labels.thRole}</th>
                  <th>{labels.thScope}</th>
                  <th aria-label={labels.thActions} />
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
                                : labels.failedRevoke,
                            );
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        {labels.revoke}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <InviteForm
        applications={applications}
        isOwner={isOwner}
        labels={labels}
      />

      <section className="card">
        <h2 className="card-title">{labels.permissionMatrix}</h2>
        <p className="cell-muted">{labels.matrixNote}</p>
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>{labels.thPermission}</th>
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
  labels,
}: {
  member: Member;
  applications: ApplicationOption[];
  busy: boolean;
  labels: Dictionary["team"];
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
          ? labels.allProjects
          : formatMessage(labels.projectsCount, {
              count: String(member.applicationIds.length),
            })}
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
        {labels.allProjects}
      </label>
      <div className="team-scope-option">
        <span>{labels.restrictedTo}</span>
        {applications.length === 0 ? (
          <span className="cell-muted">{labels.noProjectsYet}</span>
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
        {labels.saveScope}
      </button>
    </div>
  );
}

function InviteForm({
  applications,
  isOwner,
  labels,
}: {
  applications: ApplicationOption[];
  isOwner: boolean;
  labels: Dictionary["team"];
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
          typeof body.error === "string" ? body.error : labels.inviteFailed,
        );
      }
      setInviteUrl(String(body.inviteUrl));
      setEmail("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.inviteFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="card-title">{labels.inviteTitle}</h2>
      <form className="team-invite-form" onSubmit={submit}>
        <label className="filter-field">
          <span className="filter-field-label">{labels.email}</span>
          <input
            className="form-input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="operator@yourcompany.com"
            required
          />
        </label>
        <label className="filter-field">
          <span className="filter-field-label">{labels.role}</span>
          <select
            className="form-input"
            value={role}
            title={labels.roleDescriptions[role]}
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
        <label className="filter-field">
          <span className="filter-field-label">{labels.projectAccess}</span>
          <select
            className="form-input"
            value={scope}
            onChange={(event) =>
              setScope(event.target.value as "all" | "restricted")
            }
          >
            <option value="all">{labels.allProjects}</option>
            <option value="restricted">{labels.restrictedSelection}</option>
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
          {busy ? labels.inviting : labels.createInvitation}
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
      {inviteUrl && (
        <div className="team-invite-result">
          <p>{labels.inviteResultIntro}</p>
          <code className="cell-mono">{inviteUrl}</code>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigator.clipboard.writeText(inviteUrl)}
          >
            {labels.copyLink}
          </button>
        </div>
      )}
    </section>
  );
}
