import Link from "next/link";
import { PageContainer } from "@/components/layout/PageContainer";
import { formatMessage, getDictionary } from "@/i18n/server";
import { getConsoleContext } from "@/server/control-plane/context";
import {
  getDeveloperHealth,
  getDeveloperQuickstart,
} from "@/server/control-plane/developer";

export const dynamic = "force-dynamic";

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="developer-code">
      <code>{children}</code>
    </pre>
  );
}

export default async function DeveloperQuickstartPage() {
  const [context, dictionary] = await Promise.all([
    getConsoleContext(),
    getDictionary(),
  ]);
  const t = dictionary.developer;
  const application = context.selectedApplication;
  const environmentLabel =
    context.environment === "test"
      ? dictionary.common.sandbox
      : dictionary.common.production;

  if (!application) {
    return (
      <PageContainer title={t.title} description={t.noProjectDescription}>
        <div className="empty-state">
          <h2 className="empty-state-title">{t.emptyTitle}</h2>
          <p className="empty-state-desc">{t.emptyDesc}</p>
          <div className="empty-state-actions">
            <Link className="btn btn-primary" href="/applications/new">
              {t.createProject}
            </Link>
          </div>
        </div>
      </PageContainer>
    );
  }

  const [health, quickstart] = await Promise.all([
    getDeveloperHealth(application.id, context.environment),
    getDeveloperQuickstart(application.id, context.environment),
  ]);
  const priceId = quickstart.catalog?.priceId ?? "price_your_price";
  const checks = [
    {
      label: t.checkApiKey,
      done: health.apiKeyCreated,
      href: "/api-keys",
      action: t.checkApiKeyAction,
    },
    {
      label: t.checkApiRequest,
      done: health.apiRequestReceived,
      href: "/developer",
      action: t.checkApiRequestAction,
    },
    {
      label: formatMessage(t.checkWebhook, { environment: environmentLabel }),
      done: health.webhookConfigured,
      href: "/webhooks",
      action: t.checkWebhookAction,
    },
    {
      label: t.checkDelivery,
      done: health.webhookDelivered,
      href: "/webhooks",
      action: t.checkDeliveryAction,
    },
    {
      label: t.checkProviderEvent,
      done: health.firstProviderEventReceived,
      href: "/events",
      action: t.checkProviderEventAction,
    },
    {
      label: t.checkFirstPayment,
      done: health.firstPaymentReceived,
      href: "/payments",
      action: t.checkFirstPaymentAction,
    },
  ];

  const initSnippet = `import { createMonetPlaneClient } from "@monetplane/sdk/server";

const monetplane = createMonetPlaneClient({
  baseUrl: process.env.MONETPLANE_BASE_URL!,
  appSecret: process.env.MONETPLANE_APP_SECRET!,
});`;

  const customerSnippet = `await monetplane.upsertCustomer({
  externalCustomerId: "user_123",
  email: "user@example.com",
  metadata: { planSource: "app" },
});`;

  const checkoutSnippet = `const checkout = await monetplane.createCheckout({
  externalCustomerId: "user_123",
  items: [{ priceId: "${priceId}", quantity: 1 }],
  environment: "${context.environment}",
  successUrl: "https://app.example.com/billing/success",
  cancelUrl: "https://app.example.com/billing/cancel",
});

// MonetPlane routes the payment provider from your product and
// environment configuration — no providerConnectionId needed.
redirect(checkout.checkoutUrl);`;

  const accessSnippet = `const access = await monetplane.checkEntitlement({
  externalCustomerId: "user_123",
  featureKey: "pro_access",
});

const credits = await monetplane.getCreditBalance(
  "user_123",
  "ai_tokens",
);`;

  return (
    <PageContainer
      title={t.title}
      description={formatMessage(t.description, {
        application: application.name,
      })}
    >
      <div className="context-notice">
        <span className="context-notice-label">{t.noticeLabel}</span>
        <strong>{environmentLabel}</strong>
        <span>{t.noticeBody}</span>
      </div>

      <section className="developer-health-grid" aria-label={t.healthAria}>
        {checks.map((check) => (
          <article
            className={`developer-health-card ${check.done ? "is-done" : ""}`}
            key={check.label}
          >
            <span className="developer-health-icon" aria-hidden="true">
              {check.done ? "✓" : "○"}
            </span>
            <div>
              <strong>{check.label}</strong>
              <p>{check.done ? t.observed : t.notObserved}</p>
            </div>
            <Link href={check.href}>
              {check.done ? t.inspect : check.action}
            </Link>
          </article>
        ))}
      </section>

      <div className="developer-quickstart-layout">
        <section className="developer-panel developer-quickstart-main">
          <div className="developer-panel-heading">
            <div>
              <span className="developer-step">01</span>
              <h2>{t.step1Title}</h2>
              <p>{t.step1Desc}</p>
            </div>
            <Link className="btn btn-secondary" href="/api-keys">
              {t.manageApiKeys}
            </Link>
          </div>
          <CodeBlock>{`MONETPLANE_BASE_URL=https://billing.example.com\nMONETPLANE_APP_SECRET=mp_app_••••••••`}</CodeBlock>

          <div className="developer-sdk-distribution-note">
            <strong>{t.sdkNoteTitle}</strong>
            <span>{t.sdkNoteBody}</span>
          </div>

          <div className="developer-panel-heading developer-step-heading">
            <div>
              <span className="developer-step">02</span>
              <h2>{t.step2Title}</h2>
            </div>
          </div>
          <CodeBlock>{initSnippet}</CodeBlock>

          <div className="developer-panel-heading developer-step-heading">
            <div>
              <span className="developer-step">03</span>
              <h2>{t.step3Title}</h2>
            </div>
          </div>
          <CodeBlock>{customerSnippet}</CodeBlock>

          <div className="developer-panel-heading developer-step-heading">
            <div>
              <span className="developer-step">04</span>
              <h2>{t.step4Title}</h2>
              <p>
                {formatMessage(t.step4Desc, { environment: environmentLabel })}
              </p>
            </div>
          </div>
          <CodeBlock>{checkoutSnippet}</CodeBlock>

          <div className="developer-panel-heading developer-step-heading">
            <div>
              <span className="developer-step">05</span>
              <h2>{t.step5Title}</h2>
            </div>
          </div>
          <CodeBlock>{accessSnippet}</CodeBlock>
        </section>

        <aside className="developer-panel developer-reference-card">
          <h2>{t.referencesTitle}</h2>
          <dl>
            <div>
              <dt>{t.refProject}</dt>
              <dd className="cell-mono">{application.id}</dd>
            </div>
            <div>
              <dt>{t.refEnvironment}</dt>
              <dd>{environmentLabel}</dd>
            </div>
            <div>
              <dt>{t.refProvider}</dt>
              <dd className="cell-mono">
                {quickstart.provider?.id ?? t.notConnected}
              </dd>
            </div>
            <div>
              <dt>{t.refPrice}</dt>
              <dd className="cell-mono">
                {quickstart.catalog?.priceId ?? t.noActivePrice}
              </dd>
            </div>
          </dl>
          {!quickstart.provider && (
            <Link className="btn btn-primary" href="/providers/new">
              {formatMessage(t.connectProviderAction, {
                environment: environmentLabel,
              })}
            </Link>
          )}
          {!quickstart.catalog && (
            <Link className="btn btn-secondary" href="/products/new">
              {t.createProduct}
            </Link>
          )}
        </aside>
      </div>
    </PageContainer>
  );
}
