"use client";

import { useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries/en";

/** Self-service password rotation (roundtable 2026-10-06, PR1). */
export function PasswordChangeForm({
  labels,
}: {
  labels: Dictionary["settings"];
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setDone(false);
    if (newPassword !== confirm) {
      setError(labels.passwordsMismatch);
      return;
    }
    if (newPassword.length < 8) {
      setError(labels.passwordTooShort);
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/admin/session/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(
          typeof body.error === "string" ? body.error : labels.passwordFailed,
        );
      }
      setDone(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.passwordFailed);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card">
      <h2 className="card-title">{labels.passwordCard}</h2>
      <form className="team-invite-form" onSubmit={submit}>
        <label className="filter-field">
          <span className="filter-field-label">{labels.currentPassword}</span>
          <input
            className="form-input"
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            required
            disabled={pending}
          />
        </label>
        <label className="filter-field">
          <span className="filter-field-label">{labels.newPassword}</span>
          <input
            className="form-input"
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
            disabled={pending}
          />
        </label>
        <label className="filter-field">
          <span className="filter-field-label">{labels.confirmPassword}</span>
          <input
            className="form-input"
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
            required
            disabled={pending}
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? labels.changing : labels.changeButton}
        </button>
      </form>
      {done && <p className="team-notice">{labels.passwordChanged}</p>}
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}
