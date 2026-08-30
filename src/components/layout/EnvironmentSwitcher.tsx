"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ConsoleEnvironment } from "@/server/control-plane/context";

type EnvironmentSwitcherProps = {
  applicationId: string | null;
  environment: ConsoleEnvironment;
};

const environments: Array<{
  value: ConsoleEnvironment;
  label: string;
}> = [
  { value: "test", label: "Sandbox" },
  { value: "live", label: "Production" },
];

export function EnvironmentSwitcher({
  applicationId,
  environment,
}: EnvironmentSwitcherProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function selectEnvironment(nextEnvironment: ConsoleEnvironment) {
    if (!applicationId || nextEnvironment === environment) return;
    setPending(true);
    try {
      const response = await fetch("/api/admin/console-context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          applicationId,
          environment: nextEnvironment,
        }),
      });
      if (!response.ok) throw new Error("Failed to switch environment");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="environment-switcher" aria-label="Billing environment">
      {environments.map((item) => {
        const active = item.value === environment;
        return (
          <button
            key={item.value}
            type="button"
            className={`environment-switcher-option${active ? " is-active" : ""}`}
            aria-pressed={active}
            disabled={pending || !applicationId}
            onClick={() => void selectEnvironment(item.value)}
          >
            <span
              className={`environment-switcher-dot environment-switcher-dot-${item.value}`}
              aria-hidden="true"
            />
            {item.label}
          </button>
        );
      })}
    </section>
  );
}
