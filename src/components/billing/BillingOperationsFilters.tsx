import Link from "next/link";
import type { Dictionary } from "@/i18n/dictionaries/en";
import type { BillingOperationsFilter } from "@/server/control-plane/billing-operations";

type ProviderOption = {
  id: string;
  name: string;
  provider: string;
  mode: string;
};

type BillingOperationsFiltersProps = {
  action: string;
  filter: BillingOperationsFilter;
  statuses: Array<{ value: string; label: string }>;
  providers: ProviderOption[];
  /** Locale-resolved labels. */
  labels: Dictionary["billingFilters"];
};

export function BillingOperationsFilters({
  action,
  filter,
  statuses,
  providers,
  labels,
}: BillingOperationsFiltersProps) {
  const hasFilter = Boolean(
    filter.status ||
      filter.customer ||
      filter.product ||
      filter.providerConnectionId ||
      filter.from ||
      filter.to,
  );

  return (
    <form className="billing-filter-bar card" method="get" action={action}>
      <label className="filter-field">
        <span className="filter-field-label">{labels.customer}</span>
        <input
          className="form-input"
          defaultValue={filter.customer ?? ""}
          name="customer"
          placeholder={labels.customerPlaceholder}
          autoComplete="off"
        />
      </label>
      <label className="filter-field">
        <span className="filter-field-label">{labels.product}</span>
        <input
          className="form-input"
          defaultValue={filter.product ?? ""}
          name="product"
          placeholder={labels.productPlaceholder}
          autoComplete="off"
        />
      </label>
      <label className="filter-field">
        <span className="filter-field-label">{labels.status}</span>
        <select
          className="form-input"
          defaultValue={filter.status ?? ""}
          name="status"
        >
          <option value="">{labels.allStatuses}</option>
          {statuses.map((status) => (
            <option key={status.value} value={status.value}>
              {status.label}
            </option>
          ))}
        </select>
      </label>
      <label className="filter-field">
        <span className="filter-field-label">{labels.provider}</span>
        <select
          className="form-input"
          defaultValue={filter.providerConnectionId ?? ""}
          name="providerConnectionId"
        >
          <option value="">{labels.allProviders}</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name} · {provider.mode}
            </option>
          ))}
        </select>
      </label>
      <label className="filter-field">
        <span className="filter-field-label">{labels.from}</span>
        <input
          className="form-input"
          defaultValue={filter.from ?? ""}
          name="from"
          type="date"
        />
      </label>
      <label className="filter-field">
        <span className="filter-field-label">{labels.to}</span>
        <input
          className="form-input"
          defaultValue={filter.to ?? ""}
          name="to"
          type="date"
        />
      </label>
      <div className="billing-filter-actions">
        <button className="btn btn-secondary" type="submit">
          {labels.apply}
        </button>
        {hasFilter && (
          <Link className="billing-clear-filter" href={action}>
            {labels.clear}
          </Link>
        )}
      </div>
    </form>
  );
}
