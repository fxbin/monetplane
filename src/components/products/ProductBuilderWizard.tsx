"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries/en";
import { formatMessage } from "@/i18n/format";
// Single money authority (audit A1): currency-aware display-amount parsing —
// zero-decimal currencies (e.g. JPY) store whole units, not units × 100.
// Pure functions, so the client component can import them directly.
import { currencyDecimals, parseDisplayAmountToMinor } from "../../lib/money";

type ProviderOption = {
  id: string;
  provider: string;
  name: string;
  mode: "test" | "live";
  // Interval/trial capability flags from the control plane so the builder
  // only offers billing shapes the selected provider supports (#64). The
  // page must pass these through — dropping them silently disabled weekly
  // billing in the UI (project review 2026-10-04, finding 1.4).
  capabilities: {
    weeklyInterval: boolean;
    trialPeriods: boolean;
  };
};

type ProductType = "one_time" | "subscription" | "credit_pack" | "usage_based";

type CreditDraft = { id: number; referenceKey: string; quantity: string };
type FeatureDraft = { id: number; referenceKey: string };

type ProductBuilderWizardProps = {
  project: { id: string; name: string; slug: string };
  environment: "test" | "live";
  providers: ProviderOption[];
  /** Locale-resolved labels (client components receive dictionary slices). */
  labels: Dictionary["wizard"];
};

function productTypesOf(t: Dictionary["wizard"]) {
  return [
    {
      value: "one_time" as ProductType,
      title: t.types.oneTimeTitle,
      eyebrow: t.types.oneTimeEyebrow,
      description: t.types.oneTimeDesc,
      billing: t.types.oneTimeBilling,
    },
    {
      value: "subscription" as ProductType,
      title: t.types.subscriptionTitle,
      eyebrow: t.types.subscriptionEyebrow,
      description: t.types.subscriptionDesc,
      billing: t.types.subscriptionBilling,
    },
    {
      value: "credit_pack" as ProductType,
      title: t.types.creditPackTitle,
      eyebrow: t.types.creditPackEyebrow,
      description: t.types.creditPackDesc,
      billing: t.types.creditPackBilling,
    },
    {
      value: "usage_based" as ProductType,
      title: t.types.usageTitle,
      eyebrow: t.types.usageEyebrow,
      description: t.types.usageDesc,
      billing: t.types.usageBilling,
    },
  ];
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
  labels,
}: ProductBuilderWizardProps) {
  const router = useRouter();
  const PRODUCT_TYPES = useMemo(() => productTypesOf(labels), [labels]);
  const STEPS = [
    labels.steps.product,
    labels.steps.pricing,
    labels.steps.benefits,
    labels.steps.provider,
    labels.steps.review,
  ];
  const environmentLabel =
    environment === "test" ? labels.sandbox : labels.production;
  const [step, setStep] = useState(0);
  const [productType, setProductType] = useState<ProductType>("subscription");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [amount, setAmount] = useState("");
  const [recurringInterval, setRecurringInterval] = useState<
    "week" | "month" | "year"
  >("month");
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
  const weeklySupported =
    selectedProvider?.capabilities.weeklyInterval ?? false;
  const amountMinor = parseDisplayAmountToMinor(amount, currency);

  const typeDefinition = PRODUCT_TYPES.find(
    (type) => type.value === productType,
  );

  function addCredit() {
    // No implicit defaults: every grant row starts empty so users never
    // accidentally commit a hidden "credits / 100" business value.
    setCredits((current) => [
      ...current,
      { id: nextDraftId, referenceKey: "", quantity: "" },
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
      if (!name.trim()) return labels.vNameRequired;
      if (!key.trim()) return labels.vKeyRequired;
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(key.trim())) {
        return labels.vKeyFormat;
      }
    }

    if (step === 1) {
      if (amountMinor === undefined) {
        return currencyDecimals(currency) === 0
          ? formatMessage(labels.vPriceWhole, { currency })
          : labels.vPriceTwo;
      }
      if (isRecurring && !recurringInterval) {
        return labels.vInterval;
      }
    }

    if (step === 2) {
      if (requiresCredits && credits.length === 0) {
        return productType === "credit_pack"
          ? labels.vCreditPackNeeds
          : labels.vUsageNeeds;
      }

      for (const credit of credits) {
        const quantity = Number(credit.quantity);
        if (!credit.referenceKey.trim()) return labels.vCreditKey;
        if (!Number.isSafeInteger(quantity) || quantity <= 0) {
          return labels.vCreditQuantity;
        }
      }
      for (const feature of features) {
        if (!feature.referenceKey.trim()) return labels.vFeatureKey;
      }
    }

    if (step === 3 && !providerConnectionId) {
      return formatMessage(labels.vChooseProvider, {
        environment: environmentLabel,
      });
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
    if (amountMinor === undefined) {
      setError(labels.vPriceBefore);
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
        throw new Error(result.error ?? labels.failedCreate);
      }

      router.push(`/products/${result.product.id}`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.failedCreate);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="product-builder" onSubmit={submit}>
      <aside className="builder-steps" aria-label={labels.ariaSteps}>
        <div className="builder-context">
          <span>{labels.project}</span>
          <strong>{project.name}</strong>
          <small>{environmentLabel}</small>
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
          {formatMessage(labels.stepOf, {
            current: String(step + 1),
            total: String(STEPS.length),
          })}
        </div>

        {step === 0 && (
          <section className="builder-panel">
            <div className="builder-panel-heading">
              <span className="builder-kicker">{labels.modelKicker}</span>
              <h2>{labels.modelTitle}</h2>
              <p>{labels.modelDesc}</p>
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
                <span>{labels.fieldName}</span>
                <input
                  value={name}
                  onChange={(event) => {
                    const value = event.target.value;
                    setName(value);
                    if (!keyTouched) setKey(slugify(value));
                  }}
                  placeholder={labels.fieldNamePlaceholder}
                />
                <small>{labels.fieldNameHint}</small>
              </label>
              <label className="field-group">
                <span>{labels.fieldKey}</span>
                <input
                  className="cell-mono"
                  value={key}
                  onChange={(event) => {
                    setKeyTouched(true);
                    setKey(event.target.value.toLowerCase());
                  }}
                  placeholder="pro-plan"
                />
                <small>{labels.fieldKeyHint}</small>
              </label>
              <label className="field-group span-two">
                <span>{labels.fieldDescription}</span>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={labels.fieldDescriptionPlaceholder}
                  rows={3}
                />
              </label>
            </div>
          </section>
        )}

        {step === 1 && (
          <section className="builder-panel">
            <div className="builder-panel-heading">
              <span className="builder-kicker">{labels.pricingKicker}</span>
              <h2>{labels.pricingTitle}</h2>
              <p>
                {isRecurring
                  ? labels.pricingRecurringDesc
                  : labels.pricingOneTimeDesc}
              </p>
            </div>

            <div className="builder-price-card">
              <div className="builder-price-inputs">
                <label className="field-group currency-field">
                  <span>{labels.currency}</span>
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
                  <span>{labels.price}</span>
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
                  <legend>{labels.billingInterval}</legend>
                  <label
                    className={`interval-option${recurringInterval === "week" ? " is-selected" : ""}${weeklySupported ? "" : " interval-option-disabled"}`}
                    title={
                      weeklySupported
                        ? undefined
                        : labels.weeklyUnsupportedTitle
                    }
                  >
                    <input
                      type="radio"
                      name="interval"
                      checked={recurringInterval === "week"}
                      disabled={!weeklySupported}
                      onChange={() => setRecurringInterval("week")}
                    />
                    <strong>{labels.weekly}</strong>
                    <span>
                      {weeklySupported
                        ? labels.weeklyRenews
                        : labels.weeklyUnsupported}
                    </span>
                  </label>
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
                    <strong>{labels.monthly}</strong>
                    <span>{labels.monthlyRenews}</span>
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
                    <strong>{labels.annual}</strong>
                    <span>{labels.annualRenews}</span>
                  </label>
                </fieldset>
              )}

              <div className="price-preview">
                <span>{labels.customerPays}</span>
                <strong>{formatPreviewAmount(amount || "0", currency)}</strong>
                <small>
                  {isRecurring
                    ? recurringInterval === "week"
                      ? labels.perWeek
                      : recurringInterval === "month"
                        ? labels.perMonth
                        : labels.perYear
                    : labels.oneTime}
                </small>
              </div>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="builder-panel">
            <div className="builder-panel-heading">
              <span className="builder-kicker">{labels.benefitsKicker}</span>
              <h2>{labels.benefitsTitle}</h2>
              <p>{labels.benefitsDesc}</p>
            </div>

            <div className="benefit-section">
              <div className="benefit-heading">
                <div>
                  <h3>{labels.credits}</h3>
                  <p>
                    {requiresCredits
                      ? labels.creditsRequired
                      : labels.creditsOptional}
                  </p>
                </div>
                <button
                  type="button"
                  className={`btn ${requiresCredits && credits.length === 0 ? "btn-primary" : "btn-secondary"}`}
                  onClick={addCredit}
                >
                  {requiresCredits && credits.length === 0
                    ? labels.addRequiredCredit
                    : labels.addCredit}
                </button>
              </div>
              {credits.length === 0 ? (
                <div className="benefit-empty">
                  {requiresCredits
                    ? labels.creditsEmptyRequired
                    : labels.creditsEmpty}
                </div>
              ) : (
                <div className="benefit-rows">
                  {credits.map((credit) => (
                    <div key={credit.id} className="benefit-row">
                      <label className="field-group">
                        <span>{labels.creditTypeKey}</span>
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
                        <span>{labels.quantity}</span>
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
                        aria-label={formatMessage(labels.removeCreditAria, {
                          key: credit.referenceKey || labels.creditFallback,
                        })}
                        onClick={() =>
                          setCredits((current) =>
                            current.filter((item) => item.id !== credit.id),
                          )
                        }
                      >
                        {labels.remove}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="benefit-section">
              <div className="benefit-heading">
                <div>
                  <h3>{labels.features}</h3>
                  <p>{labels.featuresDesc}</p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={addFeature}
                >
                  {labels.addFeature}
                </button>
              </div>
              {features.length === 0 ? (
                <div className="benefit-empty">{labels.featuresEmpty}</div>
              ) : (
                <div className="benefit-rows">
                  {features.map((feature) => (
                    <div key={feature.id} className="benefit-row feature-row">
                      <label className="field-group">
                        <span>{labels.entitlementKey}</span>
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
                        aria-label={formatMessage(labels.removeFeatureAria, {
                          key: feature.referenceKey || labels.featureFallback,
                        })}
                        onClick={() =>
                          setFeatures((current) =>
                            current.filter((item) => item.id !== feature.id),
                          )
                        }
                      >
                        {labels.remove}
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
              <span className="builder-kicker">{labels.routeKicker}</span>
              <h2>{labels.routeTitle}</h2>
              <p>{formatMessage(labels.routeDesc, { environment: "" })}</p>
            </div>

            {providers.length === 0 ? (
              <div className="provider-empty-state">
                <div>
                  <strong>
                    {formatMessage(labels.noProviderTitle, {
                      environment: environmentLabel,
                    })}
                  </strong>
                  <p>{labels.noProviderDesc}</p>
                </div>
                <Link className="btn btn-primary" href="/providers/new">
                  {labels.connectProvider}
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
                      {provider.mode === "test"
                        ? labels.sandbox
                        : labels.production}
                    </small>
                  </label>
                ))}
              </div>
            )}

            <div className="builder-note">{labels.routeNote}</div>
          </section>
        )}

        {step === 4 && (
          <section className="builder-panel">
            <div className="builder-panel-heading">
              <span className="builder-kicker">{labels.reviewKicker}</span>
              <h2>{labels.reviewTitle}</h2>
              <p>{labels.reviewDesc}</p>
            </div>

            <div className="review-grid">
              <section className="review-card">
                <span>{labels.reviewProduct}</span>
                <strong>{name || labels.reviewUntitled}</strong>
                <code>{key || "product-key"}</code>
                <p>{typeDefinition?.title}</p>
              </section>
              <section className="review-card">
                <span>{labels.reviewPrice}</span>
                <strong>{formatPreviewAmount(amount || "0", currency)}</strong>
                <p>
                  {isRecurring
                    ? recurringInterval === "month"
                      ? labels.reviewMonthlyRecurring
                      : labels.reviewAnnualRecurring
                    : labels.reviewOneTime}
                </p>
              </section>
              <section className="review-card">
                <span>{labels.reviewBenefits}</span>
                <strong>
                  {formatMessage(labels.reviewCreditGrants, {
                    count: String(credits.length),
                  })}
                </strong>
                <p>
                  {formatMessage(labels.reviewFeatures, {
                    count: String(features.length),
                  })}
                </p>
              </section>
              <section className="review-card">
                <span>{labels.reviewProvider}</span>
                <strong>
                  {selectedProvider?.name ?? labels.reviewNotSelected}
                </strong>
                <p>
                  {selectedProvider
                    ? `${selectedProvider.provider} · ${environmentLabel}`
                    : labels.reviewChooseProvider}
                </p>
              </section>
            </div>

            {(credits.length > 0 || features.length > 0) && (
              <div className="review-benefits">
                {credits.map((credit) => (
                  <span key={`credit-${credit.id}`}>
                    +{credit.quantity || "0"}{" "}
                    {credit.referenceKey || labels.reviewCreditsChip}
                  </span>
                ))}
                {features.map((feature) => (
                  <span key={`feature-${feature.id}`}>
                    {feature.referenceKey || labels.featureFallback}
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
                {labels.back}
              </button>
            )}
          </div>
          <div className="builder-actions-right">
            <Link className="btn btn-ghost" href="/products">
              {labels.cancel}
            </Link>
            {step < STEPS.length - 1 ? (
              <button type="button" className="btn btn-primary" onClick={next}>
                {labels.continue}
              </button>
            ) : (
              <button
                type="submit"
                className="btn btn-primary"
                disabled={pending || providers.length === 0}
              >
                {pending ? labels.creating : labels.createProduct}
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
