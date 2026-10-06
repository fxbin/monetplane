"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { Dictionary } from "@/i18n/dictionaries/en";
import type {
  ConsoleApplication,
  ConsoleEnvironment,
} from "@/server/control-plane/context";
import { ProjectSwitcher } from "./ProjectSwitcher";

type NavItem = {
  label: string;
  href?: string;
  icon:
    | "overview"
    | "box"
    | "credits"
    | "features"
    | "customers"
    | "payments"
    | "subscriptions"
    | "refunds"
    | "revenue"
    | "usage"
    | "providers"
    | "webhooks"
    | "quickstart"
    | "keys"
    | "events"
    | "logs"
    | "settings"
    | "team";
  comingSoon?: boolean;
};

/**
 * Section structure with dictionary keys — labels resolve from the
 * active locale's dictionary at render time (i18n, 2026-10-04).
 */
const navSections: Array<{
  labelKey?: keyof Dictionary["nav"]["sections"];
  items: Array<{
    labelKey: keyof Dictionary["nav"]["items"];
    href?: string;
    icon: NavItem["icon"];
    comingSoon?: boolean;
  }>;
}> = [
  {
    items: [{ labelKey: "overview", href: "/overview", icon: "overview" }],
  },
  {
    labelKey: "products",
    items: [
      { labelKey: "products", href: "/products", icon: "box" },
      { labelKey: "credits", icon: "credits", comingSoon: true },
      { labelKey: "features", icon: "features", comingSoon: true },
    ],
  },
  {
    labelKey: "business",
    items: [
      { labelKey: "customers", href: "/customers", icon: "customers" },
      { labelKey: "payments", href: "/payments", icon: "payments" },
      {
        labelKey: "subscriptions",
        href: "/subscriptions",
        icon: "subscriptions",
      },
      { labelKey: "refunds", href: "/refunds", icon: "refunds" },
    ],
  },
  {
    labelKey: "analytics",
    items: [
      { labelKey: "revenue", href: "/revenue", icon: "revenue" },
      { labelKey: "usage", href: "/usage", icon: "usage" },
    ],
  },
  {
    labelKey: "integrations",
    items: [
      { labelKey: "providers", href: "/providers", icon: "providers" },
      { labelKey: "webhooks", href: "/webhooks", icon: "webhooks" },
    ],
  },
  {
    labelKey: "developer",
    items: [
      { labelKey: "quickstart", href: "/developer", icon: "quickstart" },
      { labelKey: "apiKeys", href: "/api-keys", icon: "keys" },
      { labelKey: "events", href: "/events", icon: "events" },
      { labelKey: "logs", href: "/logs", icon: "logs" },
      { labelKey: "auditLog", href: "/audit", icon: "logs" },
    ],
  },
  {
    labelKey: "workspace",
    items: [
      { labelKey: "projects", href: "/applications", icon: "settings" },
      { labelKey: "team", href: "/team", icon: "team" },
    ],
  },
];

function NavIcon({ name }: { name: NavItem["icon"] }) {
  const paths: Record<NavItem["icon"], ReactNode> = {
    overview: <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />,
    box: <path d="m4 7 8-4 8 4-8 4-8-4Zm0 0v10l8 4 8-4V7M12 11v10" />,
    credits: <path d="M4 7h16v10H4zM8 11h4M4 9h16" />,
    features: (
      <path d="m12 3 2.2 4.8L19 10l-4.8 2.2L12 17l-2.2-4.8L5 10l4.8-2.2L12 3Zm7 11 1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z" />
    ),
    customers: (
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    ),
    payments: <path d="M3 6h18v12H3zM3 10h18M7 15h4" />,
    subscriptions: <path d="M20 7h-8M16 3l4 4-4 4M4 17h8M8 21l-4-4 4-4" />,
    refunds: <path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-2" />,
    revenue: <path d="M4 19V9M10 19V5M16 19v-8M22 19H2" />,
    usage: <path d="M4 18V6M10 18v-8M16 18V4M22 18H2" />,
    providers: <path d="M4 7h16v10H4zM8 3v4M16 3v4M8 17v4M16 17v4" />,
    webhooks: (
      <path d="M12 6a4 4 0 1 1-4 4M6 18a4 4 0 1 1 4-4M18 18a4 4 0 1 1-4-4" />
    ),
    quickstart: <path d="m5 19 5-5M14 4h6v6M20 4l-9 9M5 5h5M5 5v5" />,
    keys: (
      <path d="M21 2 13.6 9.4M15 6l3 3M9 15a4 4 0 1 1-5.7 5.7A4 4 0 0 1 9 15Z" />
    ),
    events: <path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" />,
    logs: <path d="M4 5h16M4 10h16M4 15h10M4 20h7" />,
    team: (
      <path d="M17 8a5 5 0 1 0-10 0 5 5 0 0 0 10 0ZM3 21v-1a6 6 0 0 1 6-6h6a6 6 0 0 1 6 6v1" />
    ),
    settings: (
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-3.5a7.9 7.9 0 0 0-.1-1l2-1.6-2-3.4-2.5 1a8 8 0 0 0-1.7-1L14.7 3h-4l-.4 2.9a8 8 0 0 0-1.7 1L6.1 6l-2 3.4 2 1.6a8 8 0 0 0 0 2l-2 1.6 2 3.4 2.5-1a8 8 0 0 0 1.7 1l.4 2.9h4l.4-2.9a8 8 0 0 0 1.7-1l2.5 1 2-3.4-2-1.6a7.9 7.9 0 0 0 .1-1Z" />
    ),
  };

  return (
    <svg aria-hidden="true" className="sidebar-icon" viewBox="0 0 24 24">
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      >
        {paths[name]}
      </g>
    </svg>
  );
}

type SidebarNavigationProps = {
  applications: ConsoleApplication[];
  selectedApplicationId: string | null;
  environment: ConsoleEnvironment;
  canManageTeam: boolean;
  /** Locale-resolved labels (client components receive dictionary slices). */
  labels: Dictionary["nav"];
  projectSwitcherLabels: Dictionary["projectSwitcher"];
};

export function SidebarNavigation({
  applications,
  selectedApplicationId,
  environment,
  canManageTeam,
  labels,
  projectSwitcherLabels,
}: SidebarNavigationProps) {
  const pathname = usePathname();
  const visibleSections = canManageTeam
    ? navSections
    : navSections.map((section) => ({
        ...section,
        items: section.items.filter((item) => item.icon !== "team"),
      }));

  return (
    <aside className="sidebar sidebar-p1">
      <div className="sidebar-brand-row">
        <div className="sidebar-logo" aria-hidden="true">
          M
        </div>
        <div>
          <div className="sidebar-brand">MonetPlane</div>
          <div className="sidebar-brand-subtitle">{labels.brandSubtitle}</div>
        </div>
      </div>

      <section
        className="sidebar-context-card"
        aria-label={labels.aria.applicationContext}
      >
        <ProjectSwitcher
          applications={applications}
          selectedApplicationId={selectedApplicationId}
          environment={environment}
          labels={projectSwitcherLabels}
        />
        <Link className="sidebar-manage-projects" href="/applications">
          {labels.manageProjects}
        </Link>
      </section>

      <nav className="sidebar-nav sidebar-nav-p1">
        {visibleSections.map((section, sectionIndex) => (
          <div
            key={section.labelKey ?? `primary-${sectionIndex}`}
            className="sidebar-section"
          >
            {section.labelKey && (
              <span className="sidebar-section-label">
                {labels.sections[section.labelKey]}
              </span>
            )}
            <div className="sidebar-section-items">
              {section.items.map((item) => {
                const itemLabel = labels.items[item.labelKey];
                const isActive =
                  Boolean(item.href) &&
                  (pathname === item.href ||
                    pathname.startsWith(`${item.href}/`));

                if (!item.href || item.comingSoon) {
                  return (
                    <div
                      key={item.labelKey}
                      className="sidebar-link sidebar-link-disabled"
                      aria-disabled="true"
                    >
                      <NavIcon name={item.icon} />
                      <span className="sidebar-link-label">{itemLabel}</span>
                      <span className="sidebar-soon">{labels.soon}</span>
                    </div>
                  );
                }

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`sidebar-link sidebar-link-p1${isActive ? " sidebar-link-active" : ""}`}
                  >
                    <NavIcon name={item.icon} />
                    <span className="sidebar-link-label">{itemLabel}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div
          className="sidebar-link sidebar-link-disabled"
          aria-disabled="true"
        >
          <NavIcon name="settings" />
          <span className="sidebar-link-label">{labels.settings}</span>
          <span className="sidebar-soon">{labels.soon}</span>
        </div>
        <div className="sidebar-footer-note">{labels.preview}</div>
      </div>
    </aside>
  );
}
