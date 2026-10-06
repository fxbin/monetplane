"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries/en";

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

export function ApplicationCreateForm({
  labels,
}: {
  labels: Dictionary["applicationCreate"];
}) {
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
      const result = (await response.json()) as
        | CreateResult
        | { error?: string };
      if (!response.ok || !("application" in result)) {
        throw new Error(
          "error" in result && result.error ? result.error : labels.failed,
        );
      }
      setCreated(result);
      router.refresh();
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : labels.failed,
      );
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
          <span className="project-success-kicker">{labels.createdKicker}</span>
          <h2>{created.application.name}</h2>
          <p>{labels.createdDesc}</p>
          <dl className="project-summary-list">
            <div>
              <dt>{labels.projectId}</dt>
              <dd className="cell-mono">{created.application.id}</dd>
            </div>
            <div>
              <dt>{labels.slug}</dt>
              <dd className="cell-mono">{created.application.slug}</dd>
            </div>
          </dl>
        </section>

        <section className="card secret-reveal-card">
          <div>
            <span className="secret-reveal-kicker">{labels.secretKicker}</span>
            <h2>{labels.saveNowTitle}</h2>
            <p>{labels.saveNowDesc}</p>
          </div>
          <div className="secret-reveal-value">
            <code>{created.credential.secret}</code>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => void copySecret()}
            >
              {copied ? labels.copied : labels.copyKey}
            </button>
          </div>
          <div className="secret-warning">{labels.secretWarning}</div>
        </section>

        <section className="card onboarding-next-card">
          <h2>{labels.continueTitle}</h2>
          <div className="onboarding-next-actions">
            <a className="btn btn-primary" href="/providers">
              {labels.connectSandbox}
            </a>
            <a className="btn btn-secondary" href="/products">
              {labels.createProduct}
            </a>
            <a
              className="btn btn-secondary"
              href={`/applications/${created.application.id}`}
            >
              {labels.viewProject}
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
            <h2>{labels.step1Title}</h2>
            <p>{labels.step1Desc}</p>
          </div>
        </div>

        <div className="project-form-grid">
          <label className="form-field">
            <span className="form-label">{labels.projectName}</span>
            <input
              className="form-input"
              name="name"
              placeholder={labels.projectNamePlaceholder}
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
            <span className="form-label">{labels.projectSlug}</span>
            <input
              className="form-input cell-mono"
              name="slug"
              placeholder={labels.projectSlugPlaceholder}
              pattern="[a-z0-9][a-z0-9-]*"
              required
              value={slug}
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(event.target.value.toLowerCase());
              }}
            />
            <span className="form-help">{labels.slugHelp}</span>
          </label>
        </div>
      </section>

      <section className="card project-form-section">
        <div className="project-form-heading">
          <span className="project-form-step">2</span>
          <div>
            <h2>{labels.step2Title}</h2>
            <p>{labels.step2Desc}</p>
          </div>
        </div>

        <div className="project-form-grid">
          <label className="form-field">
            <span className="form-label">{labels.primaryHostname}</span>
            <input
              className="form-input"
              name="hostname"
              placeholder={labels.hostnamePlaceholder}
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
            />
          </label>
          <label className="form-field">
            <span className="form-label">{labels.callbackOrigin}</span>
            <input
              className="form-input"
              name="callbackOrigin"
              placeholder={labels.callbackPlaceholder}
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
            <h2>{labels.step3Title}</h2>
            <p>{labels.step3Desc}</p>
          </div>
        </div>
        <div className="security-callout">{labels.securityCallout}</div>
      </section>

      {error && <p className="form-error">{error}</p>}

      <div className="project-form-actions">
        <a className="btn btn-secondary" href="/applications">
          {labels.cancel}
        </a>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? labels.creating : labels.submit}
        </button>
      </div>
    </form>
  );
}
