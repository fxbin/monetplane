"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navSections = [
  {
    label: "Overview",
    items: [{ label: "Dashboard", href: "/overview" }],
  },
  {
    label: "Products",
    items: [{ label: "Products", href: "/products" }],
  },
  {
    label: "Business",
    items: [{ label: "Customers", href: "/customers" }],
  },
  {
    label: "Integrations",
    items: [{ label: "Payment Providers", href: "/providers" }],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">MonetPlane</div>
      <nav className="sidebar-nav">
        {navSections.map((section) => (
          <div key={section.label} className="sidebar-section">
            <span className="sidebar-section-label">{section.label}</span>
            {section.items.map((item) => {
              const isActive =
                pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`sidebar-link${isActive ? " sidebar-link-active" : ""}`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
