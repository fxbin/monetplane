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
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">MonetPlane</div>
      <nav className="sidebar-nav">
        {navSections.map((section) => (
          <div key={section.label} className="sidebar-section">
            <span className="sidebar-section-label">{section.label}</span>
            {section.items.map((item) => (
              <a key={item.href} href={item.href} className="sidebar-link">
                {item.label}
              </a>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
