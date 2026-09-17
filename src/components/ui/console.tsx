/**
 * Shared console UI primitives.
 *
 * These components are the canonical way to render status badges and
 * empty states in console pages. Pages must not hand-roll
 * `badge badge-*` / `empty-state` markup — keep the console visually and
 * behaviorally consistent by reusing these primitives.
 *
 * Badge class names intentionally match the raw status vocabulary used by
 * the existing CSS (badge-succeeded, badge-past_due, ...); unknown
 * statuses fall back to the neutral pending style.
 *
 * See docs/p1-console-architecture.md for the layering rules.
 */

export function StatusBadge({
  status,
  label,
}: {
  status: string;
  label?: string;
}) {
  const normalized = status.trim().toLowerCase().replace(/\s+/g, "_");
  return <span className={`badge badge-${normalized}`}>{label ?? status}</span>;
}

export function EmptyState({
  title,
  description,
  children,
  guided = false,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
  guided?: boolean;
}) {
  return (
    <div className={`empty-state${guided ? " empty-state-guided" : ""}`}>
      <h2 className="empty-state-title">{title}</h2>
      {description && <p className="empty-state-desc">{description}</p>}
      {children}
    </div>
  );
}
