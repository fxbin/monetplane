"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type CreateResult = {
  application: {
    id: string;
    name: string;
    slug: string;
  };
  credential: {
    id: string;
    name: string;
    secretPrefix: string;
    secret: string;
  };
};

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function ApplicationCreateForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [hostname, setHostname] = useState("");
  const [callbackOrigin, setCallbackOrigin] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const response = await fetch("/api/admin/applications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          slug,
          hostname: hostname || undefined,
          callbackOrigin: callbackOrigin || undefined,
        }),
      });
      const result = (await response.json()) as CreateResult | { error?: string };
      if (!response.ok || !("application" in result)) {
        throw new Error("error" in result && result.error ? result.error : "Failed to create project");
      }
      setCreated(result);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to create project");
    } finally {
      setPending(false);
    }
  }

  async function copySecret() {
    if (!created) return;
    await navigator.clipboard.writeText(created.credential.secret);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  if (created) {
    return (
      <div className="project-created-grid">
        <section className="card project-success-card">
          <span className="project-success-kicker">Project created</span>
          <h2>{created.application.name}</h2>
          <p>
            MonetPlane selected this project and switched the console to Sandbox for
            safe onboarding.
          </p>
          <dl className="project-summary-list">
            <div>
              <dt>Project ID</dt>
              <dd className="cell-mono">{created.application.id}</dd>
            </div>
            <div>
              <dt>Slug</dt>
              <dd className="cell-mono">{created.application.slug}</dd>
            </div>
          </dl>
        </section>

        <section className="card secret-reveal-card">
          <div>
            <span className="secret-reveal-kicker">Server key · shown once</span>
            <h2>Save this key now</h2>
            <p>
              This secret authenticates server-side MonetPlane SDK requests. It will
              not be shown again after you leave this page.
            </p>
          </div>
          <div className="secret-reveal-value">
            <code>{created.credential.secret}</code>
            <button className="btn btn-secondary" type="button" onClick={() => void copySecret()}>
              {copied ? "Copied" : "Copy key"}
            </button>
          </div>
          <div className="secret-warning">
            Keep this value in a server-side environment variable. Never expose it in
            browser code or a public repository.
          </div>
        </section>

        <section className="card onboarding-next-card">
          <h2>Continue setup</h2>
          <div className="onboarding-next-actions">
            <a className="btn btn-primary" href="/providers">
              Connect Sandbox provider
            </a>
            <a className="btn btn-secondary" href="/products">
              Create product
            </a>
            <a className="btn btn-secondary" href={`/applications/${created.application.id}`}>
              View project details
            </a>
          </div>
        </section>
      </div>
    );
  }

  return (
    <form className="project-create-form" onSubmit={submit}>
      <section className="card project-form-section">
        <div className="project-form-heading">
          <span className="project-form-step">1</span>
          <div>
            <h2>Project identity</h2>
            <p>Use one project for one product or website billing boundary.</p>
          </div>
        </div>

        <div className="project-form-grid">
          <label className="form-field">
            <span className="form-label">Project name</span>
            <input
              className="form-input"
              name="name"
              placeholder="PicToFu"
              required
              value={name}
              onChange={(event) => {
                const nextName = event.target.value;
                setName(nextName);
                if (!slugTouched) setSlug(slugify(nextName));
              }}
            />
          </label>
          <label className="form-field">
            <span className="form-label">Project slug</span>
            <input
              className="form-input cell-mono"
              name="slug"
              placeholder="pictofu"
              pattern="[a-z0-9][a-z0-9-]*"
              required
              value={slug}
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(event.target.value.toLowerCase());
              }}
            />
            <span className="form-help">Lowercase letters, numbers, and hyphens.</span>
          </label>
        </div>
      </section>

      <section className="card project-form-section">
        <div className="project-form-heading">
          <span className="project-form-step">2</span>
          <div>
            <h2>Domains and callbacks</h2>
            <p>Optional now. These values are used to resolve and secure billing flows.</p>
          </div>
        </div>

        <div className="project-form-grid">
          <label className="form-field">
            <span className="form-label">Primary hostname</span>
            <input
              className="form-input"
              name="hostname"
              placeholder="app.example.com"
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
            />
          </label>
          <label className="form-field">
            <span className="form-label">Allowed callback origin</span>
            <input
              className="form-input"
              name="callbackOrigin"
              placeholder="https://app.example.com"
              value={callbackOrigin}
              onChange={(event) => setCallbackOrigin(event.target.value)}
            />
          </label>
        </div>
      </section>

      <section className="card project-form-section project-form-security">
        <div className="project-form-heading">
          <span className="project-form-step">3</span>
          <div>
            <h2>Server credential</h2>
            <p>
              MonetPlane will generate one server key after project creation and show
              it exactly once.
            </p>
          </div>
        </div>
        <div className="security-callout">
          Server keys are for your backend only. Browser-side SDK usage must never
          include application credentials.
        </div>
      </section>

      {error && <p className="form-error">{error}</p>}

      <div className="project-form-actions">
        <a className="btn btn-secondary" href="/applications">
          Cancel
        </a>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? "Creating project…" : "Create project and server key"}
        </button>
      </div>
    </form>
  );
}
