# MonetPlane

**Open-source monetization control plane for multi-product builders.**

MonetPlane gives teams one place to manage monetization across multiple products, domains, and payment providers without coupling product code to a single billing vendor.

> Status: **Pre-alpha / architecture phase**

## What MonetPlane owns

- **Applications** — register multiple products in one deployment
- **Domains & branding** — resolve application context from custom checkout/account domains
- **Payment orchestration** — one-time purchases, monthly/yearly subscriptions, refunds, and provider-normalized webhooks
- **Provider adapters** — isolate Creem, Waffo, and future payment providers behind one contract
- **Entitlements** — answer what a customer is allowed to use
- **Credits** — grant, purchase, reserve, capture, release, debit, refund, and audit usage credits
- **Idempotency & auditability** — prevent duplicate webhook grants and duplicate credit consumption

## Core idea

```text
Product A ─┐
Product B ─┼──► MonetPlane ───► Creem
Product C ─┤                 ├► Waffo
Product N ─┘                 └► future providers

            one implementation
            many domains / brands
```

Each product keeps its own business data. MonetPlane only owns monetization state and the identifiers required to map a customer to an application.

## Design principles

1. **Provider-agnostic core** — provider-specific behavior stays inside adapters.
2. **Webhook is payment truth** — browser redirects never activate paid access by themselves.
3. **Entitlements decouple payment from product access** — products ask what a customer can use, not how they paid.
4. **Credits are a ledger, not a mutable number** — every grant and consumption is traceable.
5. **Atomic consumption** — concurrent requests must not overspend a credit balance.
6. **One service, many domains** — a single deployment may serve branded domains for multiple applications.
7. **Bring your own identity** — MonetPlane maps customer identities; it is not a full IAM/SSO platform in P0.

## Non-goals for P0

- Processing or storing raw card details
- Acting as a Merchant of Record or tax engine
- Replacing application authentication/authorization systems
- Storing product-specific user data
- Accounting/general-ledger functionality
- Microservices, Kafka, Kubernetes, or distributed transactions

## Architecture

- [System architecture](docs/architecture.md)
- [Payment provider contract](docs/provider-contract.md)
- [Credits and usage ledger](docs/credits-ledger.md)

## P0 outcome

P0 is complete when two example applications can share one MonetPlane deployment while using application-specific domains/configuration, complete one-time and recurring payment flows through provider adapters, receive normalized idempotent webhooks, grant entitlements/credits, and consume credits safely through the same API.
