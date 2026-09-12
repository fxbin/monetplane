"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";

type ProviderOption = {
  id: string;
  provider: string;
  name: string;
  mode: "test" | "live";
};

type ProductType = "one_time" | "subscription" | "credit_pack" | "usage_based";

type CreditDraft = { id: number; referenceKey: string; quantity: string };
type FeatureDraft = { id: number; referenceKey: string };

type ProductBuilderWizardProps = {
  project: { id: string; name: string; slug: string };
  environment: "test" | "live";
  providers: ProviderOption[];
};

const PRODUCT_TYPES: Array<{
  value: ProductType;
  title: string;
  eyebrow: string;
  description: string;
  billing: string;
}> = [
  {
    value: "one_time",
    title: "One-time purchase",
    eyebrow: "Pay once",
    description:
      "Sell a downloadable product, lifetime unlock, or single purchase.",
    billing: "One-time price",
  },
  {
    value: "subscription",
    title: "Subscription",
    eyebrow: "Recurring",
    description: "Charge monthly or annually and grant ongoing product access.",
    billing: "Monthly or annual",
  },
  {
    value: "credit_pack",
    title: "Credit pack",
    eyebrow: "Prepaid usage",
    description: "Sell a fixed bundle of credits that customers consume later.",
    billing: "One-time price + credits",
  },
  {
    value: "usage_based",
    title: "Usage-oriented plan",
    eyebrow: "Recurring allowance",
    description:
      "Charge recurring and replenish a credit allowance for metered usage.",
    billing: "Monthly or annual + credits",
  },
];

const STEPS = ["Product", "Pricing", "Benefits", "Provider", "Review"] as const;

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseAmountMinor(value: string): number | null {
  if (!/^\d+(?:\.\d{0,2})?$/.test(value.trim())) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const minor = Math.round(parsed * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

function formatPreviewAmount(value: string, currency: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return `${currency} —`;
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).format(parsed);
  } catch {
    return `${currency} ${value}`;
  }
}

export function ProductBuilderWizard({
  project,
  environment,
  providers,
}: ProductBuilderWizardProps) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [productType, setProductType] = useState<ProductType>("subscription");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [amount, setAmount] = useState("");
  const [recurringInterval, setRecurringInterval] = useState<"month" | "year">(
    "month",
  );
  const [credits, setCredits] = useState<CreditDraft[]>([]);
  const [features, setFeatures] = useState<FeatureDraft[]>([]);
  const [providerConnectionId, setProviderConnectionId] = useState(
    providers[0]?.id ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [nextDraftId, setNextDraftId] = useState(1);

  const isRecurring =
    productType === "subscription" || productType === "usage_based";
  const requiresCredits =
    productType === "credit_pack" || productType === "usage_based";
  const selectedProvider = providers.find(
    (provider) => provider.id === providerConnectionId,
  );
  const amountMinor = parseAmountMinor(amount);

  const typeDefinition = useMemo(
    () => PRODUCT_TYPES.find((type) => type.value === productType),
    [productType],
  );

  function addCredit() {
    setCredits((current) => [
      ...current,
      { id: nextDraftId, referenceKey: "credits", quantity: "100" },
    ]);
    setNextDraftId((value) => value + 1);
  }

  function addFeature() {
    setFeatures((current) => [
      ...current,
      { id: nextDraftId, referenceKey: "" },
    ]);
    setNextDraftId((value) => value + 1);
  }

  function validateCurrentStep() {
    setError(null);

    if (step === 0) {
      if (!name.trim()) return "Product name is required.";
      if (!key.trim()) return "Product key is required.";
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(key.trim())) {
        return "Product key can use lowercase letters, numbers, dots, underscores, and hyphens.";
      }
    }

    if (step === 1) {
      if (amountMinor === null) {
        return "Enter a valid non-negative price with at most two decimal places.";
      }
      if (isRecurring && !recurringInterval) {
        return "Choose a recurring billing interval.";
      }
    }

    if (step === 2) {
      if (requiresCredits && credits.length === 0) {
        return productType === "credit_pack"
          ? "A credit pack must include at least one credit grant."
          : "A usage-oriented plan needs a credit allowance to meter usage.";
      }

      for (const credit of credits) {
        const quantity = Number(credit.quantity);
        if (!credit.referenceKey.trim())
          return "Every credit grant needs a key.";
        if (!Number.isSafeInteger(quantity) || quantity <= 0) {
          return "Credit quantities must be positive whole numbers.";
        }
      }
      for (const feature of features) {
        if (!feature.referenceKey.trim())
          return "Every feature needs an entitlement key.";
      }
    }

    if (step === 3 && !providerConnectionId) {
      return `Connect or choose a ${environment === "test" ? "Sandbox" : "Production"} provider before creating the product.`;
    }

    return null;
  }

  function next() {
    const validationError = validateCurrentStep();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  }

  function back() {
    setError(null);
    setStep((current) => Math.max(current - 1, 0));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step !== STEPS.length - 1) {
      next();
      return;
    }

    const validationError = validateCurrentStep();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (amountMinor === null) {
      setError("Enter a valid price before creating the product.");
      return;
    }

    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          key: key.trim(),
          description: description.trim() || null,
          productType,
          currency,
          amountMinor,
          recurringInterval: isRecurring ? recurringInterval : undefined,
          providerConnectionId,
          credits: credits.map((credit) => ({
            referenceKey: credit.referenceKey.trim(),
            quantity: Number(credit.quantity),
          })),
          features: features.map((feature) => ({
            referenceKey: feature.referenceKey.trim(),
          })),
        }),
      });

      const result = (await response.json()) as {
        product?: { id: string };
        error?: string;
      };
      if (!response.ok || !result.product) {
        throw new Error(result.error ?? "Failed to create product");
      }

      router.push(`/products/${result.product.id}`);
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to create product",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="product-builder" onSubmit={submit}>
      <aside className="builder-steps" aria-label="Product creation steps">
        <div className="builder-context">
          <span>Project</span>
          <strong>{project.name}</strong>
          <small>{environment === "test" ? "Sandbox" : "Production"}</small>
        </div>
        <ol>
          {STEPS.map((label, index) => (
            <li
              key={label}
              className={
                index === step
                  ? "is-current"
                  : index < step
                    ? "is-complete"
                    : undefined
              }
            >
              <button
                type="button"
                onClick={() => {
                  if (index <= step) {
                    setError(null);
                    setStep(index);
                  }
                }}
                disabled={index > step}
              >
                <span>{index < step ? "✓" : index + 1}</span>
                {label}
              </button>
            </li>
          ))}
        </ol>
      </aside>

      <div className="builder-main">
        <div className="builder-progress-copy">
          Step {step + 1} of {STEPS.length}
        </div>

        {step === 0 && (
          <section className="builder-panel">
            <div className="builder-panel-heading">
              <span className="builder-kicker">Product model</span>
              <h2>What are you selling?</h2>
              <p>
                Pick the business model first. MonetPlane will only ask for the
                pricing and benefit fields that apply to that model.
              </p>
            </div>

            <div className="product-type-grid">
              {PRODUCT_TYPES.map((type) => (
                <label
                  key={type.value}
                  className={`product-type-card${productType === type.value ? " is-selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="productType"
                    value={type.value}
                    checked={productType === type.value}
                    onChange={() => {
                      setProductType(type.value);
                      if (
                        (type.value === "credit_pack" ||
                          type.value === "usage_based") &&
                        credits.length === 0
                      ) {
                        addCredit();
                      }
                    }}
                  />
                  <span className="product-type-eyebrow">{type.eyebrow}</span>
                  <strong>{type.title}</strong>
                  <p>{type.description}</p>
                  <small>{type.billing}</small>
                </label>
              ))}
            </div>

            <div className="builder-fields two-columns">
              <label className="field-group">
                <span>Product name</span>
                <input
                  value={name}
                  onChange={(event) => {
                    const value = event.target.value;
                    setName(value);
                    if (!keyTouched) setKey(slugify(value));
                  }}
                  placeholder="Pro plan"
                />
                <small>Customer-facing name shown in your catalog.</small>
              </label>
              <label className="field-group">
                <span>Product key</span>
                <input
                  className="cell-mono"
                  value={key}
                  onChange={(event) => {
                    setKeyTouched(true);
                    setKey(event.target.value.toLowerCase());
                  }}
                  placeholder="pro-plan"
                />
                <small>Stable developer identifier. Keep it URL-safe.</small>
              </label>
              <label className="field-group span-two">
                <span>Description</span>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Everything a growing customer needs."
                  rows={3}
                />
              </label>
            </div>
          </section>
        )}

        {step === 1 && (
          <section className="builder-panel">
            <div className="builder-panel-heading">
              <span className="builder-kicker">Pricing</span>
              <h2>Set the primary price</h2>
              <p>
                {isRecurring
                  ? "This product renews automatically. The current catalog contract supports monthly and annual intervals."
                  : "This product is charged once and does not renew."}
              </p>
            </div>

            <div className="builder-price-card">
              <div className="builder-price-inputs">
                <label className="field-group currency-field">
                  <span>Currency</span>
                  <select
                    value={currency}
                    onChange={(event) => setCurrency(event.target.value)}
                  >
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                    <option value="CNY">CNY</option>
                  </select>
                </label>
                <label className="field-group amount-field">
                  <span>Price</span>
                  <input
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    placeholder="19.00"
                  />
                </label>
              </div>

              {isRecurring && (
                <fieldset className="interval-choice">
                  <legend>Billing interval</legend>
                  <label
                    className={
                      recurringInterval === "month" ? "is-selected" : undefined
                    }
                  >
                    <input
                      type="radio"
                      name="interval"
                      checked={recurringInterval === "month"}
                      onChange={() => setRecurringInterval("month")}
                    />
                    <strong>Monthly</strong>
                    <span>Renews every month</span>
                  </label>
                  <label
                    className={
                      recurringInterval === "year" ? "is-selected" : undefined
                    }
                  >
                    <input
                      type="radio"
                      name="interval"
                      checked={recurringInterval === "year"}
                      onChange={() => setRecurringInterval("year")}
                    />
                    <strong>Annual</strong>
                    <span>Renews every year</span>
                  </label>
                </fieldset>
              )}

              <div className="price-preview">
                <span>Customer pays</span>
                <strong>{formatPreviewAmount(amount || "0", currency)}</strong>
                <small>
                  {isRecurring
                    ? `per ${recurringInterval === "month" ? "month" : "year"}`
                    : "one time"}
                </small>
              </div>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="builder-panel">
            <div className="builder-panel-heading">
              <span className="builder-kicker">Benefits</span>
              <h2>What does the customer receive?</h2>
              <p>
                Credits map to MonetPlane credit grant configs. Features map to
                entitlement grant configs—there is no parallel UI-only benefit
                model.
              </p>
            </div>

            <div className="benefit-section">
              <div className="benefit-heading">
                <div>
                  <h3>Credits</h3>
                  <p>
                    {requiresCredits
                      ? "Required for this product model."
                      : "Optional prepaid or recurring usage allowance."}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={addCredit}
                >
                  Add credit grant
                </button>
              </div>
              {credits.length === 0 ? (
                <div className="benefit-empty">No credits included.</div>
              ) : (
                <div className="benefit-rows">
                  {credits.map((credit) => (
                    <div key={credit.id} className="benefit-row">
                      <label className="field-group">
                        <span>Credit type key</span>
                        <input
                          className="cell-mono"
                          value={credit.referenceKey}
                          onChange={(event) =>
                            setCredits((current) =>
                              current.map((item) =>
                                item.id === credit.id
                                  ? {
                                      ...item,
                                      referenceKey:
                                        event.target.value.toLowerCase(),
                                    }
                                  : item,
                              ),
                            )
                          }
                          placeholder="generation"
                        />
                      </label>
                      <label className="field-group quantity-field">
                        <span>Quantity</span>
                        <input
                          inputMode="numeric"
                          value={credit.quantity}
                          onChange={(event) =>
                            setCredits((current) =>
                              current.map((item) =>
                                item.id === credit.id
                                  ? { ...item, quantity: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="benefit-remove"
                        aria-label={`Remove ${credit.referenceKey || "credit"} grant`}
                        onClick={() =>
                          setCredits((current) =>
                            current.filter((item) => item.id !== credit.id),
                          )
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="benefit-section">
              <div className="benefit-heading">
                <div>
                  <h3>Features</h3>
                  <p>Entitlement keys unlocked after successful purchase.</p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={addFeature}
                >
                  Add feature
                </button>
              </div>
              {features.length === 0 ? (
                <div className="benefit-empty">
                  No feature entitlements included.
                </div>
              ) : (
                <div className="benefit-rows">
                  {features.map((feature) => (
                    <div key={feature.id} className="benefit-row feature-row">
                      <label className="field-group">
                        <span>Entitlement key</span>
                        <input
                          className="cell-mono"
                          value={feature.referenceKey}
                          onChange={(event) =>
                            setFeatures((current) =>
                              current.map((item) =>
                                item.id === feature.id
                                  ? {
                                      ...item,
                                      referenceKey:
                                        event.target.value.toLowerCase(),
                                    }
                                  : item,
                              ),
                            )
                          }
                          placeholder="export.hd"
                        />
                      </label>
                      <button
                        type="button"
                        className="benefit-remove"
                        aria-label={`Remove ${feature.referenceKey || "feature"}`}
                        onClick={() =>
                          setFeatures((current) =>
                            current.filter((item) => item.id !== feature.id),
                          )
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="builder-panel">
            <div className="builder-panel-heading">
              <span className="builder-kicker">Payment route</span>
              <h2>Choose the provider for this environment</h2>
              <p>
                This becomes the catalog routing preference for the current
                {environment === "test" ? " Sandbox" : " Production"} context.
                Checkout still keeps provider selection explicit in the P0 API.
              </p>
            </div>

            {providers.length === 0 ? (
              <div className="provider-empty-state">
                <div>
                  <strong>
                    No {environment === "test" ? "Sandbox" : "Production"}{" "}
                    provider connected
                  </strong>
                  <p>
                    Connect a provider first, then return here to finish the
                    sellable product.
                  </p>
                </div>
                <Link className="btn btn-primary" href="/providers/new">
                  Connect provider
                </Link>
              </div>
            ) : (
              <div className="provider-option-list">
                {providers.map((provider) => (
                  <label
                    key={provider.id}
                    className={`provider-option-card${providerConnectionId === provider.id ? " is-selected" : ""}`}
                  >
                    <input
                      type="radio"
                      name="provider"
                      checked={providerConnectionId === provider.id}
                      onChange={() => setProviderConnectionId(provider.id)}
                    />
                    <div className="provider-mark">
                      {provider.provider.slice(0, 1).toUpperCase()}
                    </div>
                    <div>
                      <strong>{provider.name}</strong>
                      <span>{provider.provider}</span>
                    </div>
                    <small>
                      {provider.mode === "test" ? "Sandbox" : "Production"}
                    </small>
                  </label>
                ))}
              </div>
            )}

            <div className="builder-note">
              Provider routing is stored per environment in product metadata.
              Catalog, credits, and customer state remain project-scoped until
              #49 defines full Sandbox/Production data isolation.
            </div>
          </section>
        )}

        {step === 4 && (
          <section className="builder-panel">
            <div className="builder-panel-heading">
              <span className="builder-kicker">Review</span>
              <h2>Ready to create</h2>
              <p>
                Review the catalog object MonetPlane will create. Product,
                primary price, and grants are committed atomically.
              </p>
            </div>

            <div className="review-grid">
              <section className="review-card">
                <span>Product</span>
                <strong>{name || "Untitled product"}</strong>
                <code>{key || "product-key"}</code>
                <p>{typeDefinition?.title}</p>
              </section>
              <section className="review-card">
                <span>Price</span>
                <strong>{formatPreviewAmount(amount || "0", currency)}</strong>
                <p>
                  {isRecurring
                    ? `${recurringInterval === "month" ? "Monthly" : "Annual"} recurring`
                    : "One-time"}
                </p>
              </section>
              <section className="review-card">
                <span>Benefits</span>
                <strong>
                  {credits.length} credit grant{credits.length === 1 ? "" : "s"}
                </strong>
                <p>
                  {features.length} feature{features.length === 1 ? "" : "s"}
                </p>
              </section>
              <section className="review-card">
                <span>Provider</span>
                <strong>{selectedProvider?.name ?? "Not selected"}</strong>
                <p>
                  {selectedProvider
                    ? `${selectedProvider.provider} · ${environment === "test" ? "Sandbox" : "Production"}`
                    : "Choose a provider before creating"}
                </p>
              </section>
            </div>

            {(credits.length > 0 || features.length > 0) && (
              <div className="review-benefits">
                {credits.map((credit) => (
                  <span key={`credit-${credit.id}`}>
                    +{credit.quantity || "0"} {credit.referenceKey || "credits"}
                  </span>
                ))}
                {features.map((feature) => (
                  <span key={`feature-${feature.id}`}>
                    {feature.referenceKey || "feature"}
                  </span>
                ))}
              </div>
            )}
          </section>
        )}

        {error && (
          <div className="builder-error" role="alert">
            {error}
          </div>
        )}

        <div className="builder-actions">
          <div>
            {step > 0 && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={back}
                disabled={pending}
              >
                Back
              </button>
            )}
          </div>
          <div className="builder-actions-right">
            <Link className="btn btn-ghost" href="/products">
              Cancel
            </Link>
            {step < STEPS.length - 1 ? (
              <button type="button" className="btn btn-primary" onClick={next}>
                Continue
              </button>
            ) : (
              <button
                type="submit"
                className="btn btn-primary"
                disabled={pending || providers.length === 0}
              >
                {pending ? "Creating…" : "Create product"}
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
