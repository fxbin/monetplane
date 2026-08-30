"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type ApplicationSummary = {
  id: string;
  name: string;
  slug: string;
  status: string;
};

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
    | "keys"
    | "events"
    | "logs"
    | "settings";
  comingSoon?: boolean;
};

const navSections: Array<{ label?: string; items: NavItem[] }> = [
  {
    items: [{ label: "Overview", href: "/overview", icon: "overview" }],
  },
  {
    label: "Products",
    items: [
      { label: "Products", href: "/products", icon: "box" },
      { label: "Credits", icon: "credits", comingSoon: true },
      { label: "Features", icon: "features", comingSoon: true },
    ],
  },
  {
    label: "Business",
    items: [
      { label: "Customers", href: "/customers", icon: "customers" },
      { label: "Payments", icon: "payments", comingSoon: true },
      { label: "Subscriptions", icon: "subscriptions", comingSoon: true },
      { label: "Refunds", icon: "refunds", comingSoon: true },
    ],
  },
  {
    label: "Analytics",
    items: [
      { label: "Revenue", icon: "revenue", comingSoon: true },
      { label: "Usage", icon: "usage", comingSoon: true },
    ],
  },
  {
    label: "Integrations",
    items: [
      { label: "Payment Providers", href: "/providers", icon: "providers" },
      { label: "Webhooks", icon: "webhooks", comingSoon: true },
    ],
  },
  {
    label: "Developer",
    items: [
      { label: "API Keys", icon: "keys", comingSoon: true },
      { label: "Events", icon: "events", comingSoon: true },
      { label: "Logs", icon: "logs", comingSoon: true },
    ],
  },
];

function NavIcon({ name }: { name: NavItem["icon"] }) {
  const paths: Record<NavItem["icon"], React.ReactNode> = {
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
    keys: (
      <path d="M21 2 13.6 9.4M15 6l3 3M9 15a4 4 0 1 1-5.7 5.7A4 4 0 0 1 9 15Z" />
    ),
    events: <path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" />,
    logs: <path d="M4 5h16M4 10h16M4 15h10M4 20h7" />,
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

export function SidebarNavigation({
  applications,
}: {
  applications: ApplicationSummary[];
}) {
  const pathname = usePathname();
  const activeApplications = applications.filter(
    (application) => application.status === "active",
  );
  const scopeLabel =
    activeApplications.length === 1
      ? activeApplications[0]?.name
      : activeApplications.length > 1
        ? "All applications"
        : "No applications";

  return (
    <aside className="sidebar sidebar-p1">
      <div className="sidebar-brand-row">
        <div className="sidebar-logo" aria-hidden="true">
          M
        </div>
        <div>
          <div className="sidebar-brand">MonetPlane</div>
          <div className="sidebar-brand-subtitle">Billing control plane</div>
        </div>
      </div>

      <section
        className="sidebar-context-card"
        aria-label="Application context"
      >
        <span className="sidebar-context-label">Project scope</span>
        <div className="sidebar-context-value-row">
          <span className="sidebar-context-dot" />
          <span className="sidebar-context-value">{scopeLabel}</span>
        </div>
        <span className="sidebar-context-meta">
          {activeApplications.length > 0
            ? `${activeApplications.length} active application${activeApplications.length === 1 ? "" : "s"}`
            : "Create an application to get started"}
        </span>
      </section>

      <nav className="sidebar-nav sidebar-nav-p1">
        {navSections.map((section, sectionIndex) => (
          <div
            key={section.label ?? `primary-${sectionIndex}`}
            className="sidebar-section"
          >
            {section.label && (
              <span className="sidebar-section-label">{section.label}</span>
            )}
            <div className="sidebar-section-items">
              {section.items.map((item) => {
                const isActive =
                  Boolean(item.href) &&
                  (pathname === item.href ||
                    pathname.startsWith(`${item.href}/`));

                if (!item.href || item.comingSoon) {
                  return (
                    <div
                      key={item.label}
                      className="sidebar-link sidebar-link-disabled"
                      aria-disabled="true"
                    >
                      <NavIcon name={item.icon} />
                      <span className="sidebar-link-label">{item.label}</span>
                      <span className="sidebar-soon">Soon</span>
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
                    <span className="sidebar-link-label">{item.label}</span>
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
          <span className="sidebar-link-label">Settings</span>
          <span className="sidebar-soon">Soon</span>
        </div>
        <div className="sidebar-footer-note">P1 Console preview</div>
      </div>
    </aside>
  );
}
