import type { ReactNode } from "react";

type PrimaryAction = {
  label: string;
  href: string;
};

type PageContainerProps = {
  title: string;
  description: string;
  primaryAction?: PrimaryAction;
  children: ReactNode;
};

export function PageContainer({
  title,
  description,
  primaryAction,
  children,
}: PageContainerProps) {
  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-text">
          <h1 className="page-title">{title}</h1>
          <p className="page-description">{description}</p>
        </div>
        {primaryAction && (
          <a className="btn btn-primary" href={primaryAction.href}>
            {primaryAction.label}
          </a>
        )}
      </div>
      <div className="page-body">{children}</div>
    </div>
  );
}
