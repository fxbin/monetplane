import type { ReactNode } from "react";

/**
 * Shared form primitives (2026-10-04): audit, events, logs, and the team
 * forms each hand-rolled bare <label><span> + unstyled <input> markup, so
 * their controls drifted from the standard .form-input look of the rest of
 * the console. These components pin one implementation — controls always
 * carry .form-input styling inside any layout class
 * (developer-filter-bar / audit-filters / team-invite-form / form-field).
 */

export type FilterTextFieldProps = {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  type?: "text" | "email" | "date" | "password" | "number";
  required?: boolean;
  title?: string;
};

export function FilterTextField({
  label,
  name,
  defaultValue,
  placeholder,
  type = "text",
  required,
  title,
}: FilterTextFieldProps) {
  return (
    <label className="filter-field">
      <span className="filter-field-label">{label}</span>
      <input
        className="form-input"
        type={type}
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        title={title}
        autoComplete="off"
      />
    </label>
  );
}

export type FilterSelectFieldProps = {
  label: string;
  name: string;
  defaultValue?: string;
  options: Array<{ value: string; label: string }>;
  title?: string;
};

export function FilterSelectField({
  label,
  name,
  defaultValue,
  options,
  title,
}: FilterSelectFieldProps) {
  return (
    <label className="filter-field">
      <span className="filter-field-label">{label}</span>
      <select
        className="form-input"
        name={name}
        defaultValue={defaultValue}
        title={title}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function FilterActions({ children }: { children: ReactNode }) {
  return <div className="developer-filter-actions">{children}</div>;
}
