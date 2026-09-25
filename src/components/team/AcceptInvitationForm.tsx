"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

export function AcceptInvitationForm({ token }: { token: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const passwordId = useId();
  const confirmId = useId();

  if (!token) {
    return (
      <p className="form-error">
        This invitation link is missing its token. Ask an admin for a fresh
        link.
      </p>
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, name, password }),
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(
          typeof body.error === "string"
            ? body.error
            : "Failed to accept invitation",
        );
      }
      router.push("/login");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="login-form">
      <div className="form-field">
        <label htmlFor={nameId} className="form-label">
          Your name
        </label>
        <input
          id={nameId}
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="form-input"
          placeholder="Ada Lovelace"
          required
          disabled={loading}
        />
      </div>
      <div className="form-field">
        <label htmlFor={passwordId} className="form-label">
          Password
        </label>
        <input
          id={passwordId}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="form-input"
          placeholder="At least 8 characters"
          minLength={8}
          required
          disabled={loading}
        />
      </div>
      <div className="form-field">
        <label htmlFor={confirmId} className="form-label">
          Confirm password
        </label>
        <input
          id={confirmId}
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          className="form-input"
          required
          disabled={loading}
        />
      </div>

      {error && <p className="form-error">{error}</p>}

      <button type="submit" className="login-btn" disabled={loading}>
        {loading ? "Joining…" : "Join workspace"}
      </button>
    </form>
  );
}
