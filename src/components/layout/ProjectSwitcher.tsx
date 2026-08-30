"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type {
  ConsoleApplication,
  ConsoleEnvironment,
} from "@/server/control-plane/context";

type ProjectSwitcherProps = {
  applications: ConsoleApplication[];
  selectedApplicationId: string | null;
  environment: ConsoleEnvironment;
};

export function ProjectSwitcher({
  applications,
  selectedApplicationId,
  environment,
}: ProjectSwitcherProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function selectApplication(applicationId: string) {
    if (!applicationId || applicationId === selectedApplicationId) return;
    setPending(true);
    try {
      const response = await fetch("/api/admin/console-context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ applicationId, environment }),
      });
      if (!response.ok) throw new Error("Failed to switch project");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  if (applications.length === 0) {
    return (
      <div className="project-switcher-empty">
        <span>No applications</span>
        <a href="/applications/new">Create project</a>
      </div>
    );
  }

  return (
    <label className="project-switcher">
      <span className="project-switcher-label">Project</span>
      <span className="project-switcher-control">
        <span className="project-switcher-dot" aria-hidden="true" />
        <select
          aria-label="Current project"
          disabled={pending}
          value={selectedApplicationId ?? applications[0]?.id ?? ""}
          onChange={(event) => void selectApplication(event.target.value)}
        >
          {applications.map((application) => (
            <option key={application.id} value={application.id}>
              {application.name}
            </option>
          ))}
        </select>
      </span>
      <span className="project-switcher-meta">
        {pending ? "Switching…" : "Application-scoped console data"}
      </span>
    </label>
  );
}
