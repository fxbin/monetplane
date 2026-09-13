import Link from "next/link";
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
};

export function BillingOperationsFilters({
  action,
  filter,
  statuses,
  providers,
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
      <label>
        <span>Customer</span>
        <input
          defaultValue={filter.customer ?? ""}
          name="customer"
          placeholder="External ID or email"
        />
      </label>
      <label>
        <span>Product</span>
        <input
          defaultValue={filter.product ?? ""}
          name="product"
          placeholder="Name or key"
        />
      </label>
      <label>
        <span>Status</span>
        <select defaultValue={filter.status ?? ""} name="status">
          <option value="">All statuses</option>
          {statuses.map((status) => (
            <option key={status.value} value={status.value}>
              {status.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Provider</span>
        <select
          defaultValue={filter.providerConnectionId ?? ""}
          name="providerConnectionId"
        >
          <option value="">All providers</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name} · {provider.mode}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>From</span>
        <input defaultValue={filter.from ?? ""} name="from" type="date" />
      </label>
      <label>
        <span>To</span>
        <input defaultValue={filter.to ?? ""} name="to" type="date" />
      </label>
      <div className="billing-filter-actions">
        <button className="btn btn-secondary" type="submit">
          Apply
        </button>
        {hasFilter && (
          <Link className="billing-clear-filter" href={action}>
            Clear
          </Link>
        )}
      </div>
    </form>
  );
}
