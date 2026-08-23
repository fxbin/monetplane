# MonetPlane Design System

## 1. Product UI Positioning

MonetPlane is not a traditional admin dashboard.

It is a **Developer Billing & Payment Infrastructure** platform for indie developers and small product teams.

The product helps developers quickly add payment, subscription, credit, entitlement, and multi-provider billing capabilities to their own products.

Core positioning:

```text
One integration for:
- Products
- Plans
- One-time payments
- Weekly / monthly / yearly subscriptions
- Credits
- Entitlements
- Customers
- Payment providers
- Webhooks
- Developer APIs
```

The interface should feel:

```text
Warm Neutral
Developer SaaS
Financial Trust
Clear Operations
Low AI Feeling
```

Avoid making the product feel like:

```text
Generic admin template
Crypto dashboard
AI SaaS template
Enterprise finance system
Over-designed data screen
```

---

## 2. Visual Direction

The UI should feel calm, warm, trustworthy, and developer-friendly.

The visual language should be inspired by modern SaaS infrastructure tools, but with a softer and warmer financial product feeling.

Preferred direction:

```text
Light background
Warm neutral sidebar
White cards
Soft borders
Low-saturation accents
Clear typography
Minimal gradients
High information clarity
```

Avoid:

```text
High-saturation purple
Blue-purple gradients
Cyber / AI feeling
Large empty states without guidance
Heavy shadows
Overly colorful charts
Complicated decorative illustrations
```

---

## 3. Color Tokens

### 3.1 Background

```css
--color-bg-page: #FAF8F5;
--color-bg-sidebar: #F4F0EA;
--color-bg-card: #FFFFFF;
--color-bg-muted: #F7F4EF;
--color-bg-hover: #EFEAE2;
--color-border: #E8E2D8;
--color-border-subtle: #F0ECE5;
```

### 3.2 Text

```css
--color-text-primary: #111827;
--color-text-secondary: #374151;
--color-text-muted: #6B7280;
--color-text-subtle: #9CA3AF;
--color-text-inverse: #FFFFFF;
```

### 3.3 Brand

```css
--color-brand-primary: #111827;
--color-brand-secondary: #6B5BB7;
--color-brand-soft: #EFEAEF;
--color-brand-hover: #0F172A;
```

Usage:

```text
Primary buttons should usually use dark navy / near-black.
Purple should be used only as a small brand accent.
Do not use large purple gradients.
```

### 3.4 Status

```css
--color-success: #4F8F45;
--color-success-bg: #EAF5E8;

--color-warning: #D97706;
--color-warning-bg: #FFF4E5;

--color-danger: #DC4C3F;
--color-danger-bg: #FDECEC;

--color-info: #2F6FB2;
--color-info-bg: #EAF2FB;

--color-neutral: #6B7280;
--color-neutral-bg: #F3F4F6;
```

### 3.5 Charts

```css
--chart-revenue: #2F2F2F;
--chart-payments: #2F6FB2;
--chart-success: #4F8F45;
--chart-subscription: #6B5BB7;
--chart-credits: #1F9AA5;
--chart-warning: #D97706;
--chart-danger: #DC4C3F;
```

Chart rules:

```text
Use fewer chart colors.
Revenue charts should feel stable and trustworthy.
Avoid neon colors.
Avoid excessive gradients.
Use clear legends and readable labels.
```

---

## 4. Layout Principles

### 4.1 Global Layout

Use a stable SaaS dashboard layout:

```text
Left sidebar
Top action bar
Main content area
Card-based content sections
```

Recommended desktop layout:

```text
Sidebar width: 240px
Main content max width: 1280px to 1440px
Page horizontal padding: 24px to 32px
Card radius: 12px to 16px
Card padding: 20px to 24px
```

### 4.2 Page Structure

Every major page should follow this structure:

```text
Page title
Short description
Primary action
Optional filters
Main content
Secondary content
Empty state or guidance
```

Example:

```text
Products
Create and manage what your customers can buy.

[+ Create product]

Product cards / table
```

### 4.3 Information Density

The UI should be clean, but not empty.

Avoid large blank areas with only one button in the center.

Empty states must always guide users toward the next useful action.

---

## 5. Navigation Structure

Recommended sidebar navigation:

```text
Overview

Products
  Products
  Credits
  Features

Business
  Customers
  Payments
  Subscriptions
  Refunds

Analytics
  Revenue
  Usage

Integrations
  Payment Providers
  Webhooks

Developer
  API Keys
  Events
  Logs

Settings
```

### 5.1 Project First

MonetPlane should be organized around Projects.

A project represents one product or website that uses MonetPlane.

Examples:

```text
ahaframe.com
PicTofu
Chinese Learning
SeeAI
```

The sidebar should include:

```text
Project selector
Environment selector
```

Example:

```text
Project: ahaframe.com
Environment: Production
```

---

## 6. Component Guidelines

### 6.1 Metric Cards

Metric cards are used on Overview and Analytics pages.

Each card should include:

```text
Metric label
Primary value
Trend indicator
Small chart
```

Example:

```text
Revenue
$2,842.20
↑ 12.4%
small line chart
```

Rules:

```text
Use 4 to 6 cards per row on wide desktop.
Do not overload cards with too many details.
Use green only for positive movement.
Use red/orange only for warning or negative movement.
```

### 6.2 Buttons

Primary buttons:

```text
Dark background
White text
Clear action verb
```

Examples:

```text
Create product
Get your API keys
Connect provider
```

Secondary buttons:

```text
White or transparent background
Subtle border
Dark text
```

Examples:

```text
View docs
More filters
View all
```

Avoid vague labels:

```text
Submit
Confirm
Next
```

Prefer specific labels:

```text
Create product
Connect Stripe
Generate API key
Create checkout
```

### 6.3 Cards

Cards should be used for:

```text
Metric summaries
Provider status
Product summaries
Recent payments
Tasks
API quickstart
```

Card style:

```css
background: #FFFFFF;
border: 1px solid #E8E2D8;
border-radius: 14px;
box-shadow: subtle or none;
```

### 6.4 Tables

Tables should be used for operational data:

```text
Payments
Customers
Subscriptions
Refunds
Events
Logs
```

Table rules:

```text
Important status should be visible at a glance.
Use badges for status.
Use filters above the table.
Keep row height comfortable.
Use detail drawer or detail page for complex records.
```

### 6.5 Badges

Status badges should be compact and readable.

Examples:

```text
Succeeded
Failed
Processing
Refunded
Connected
Disconnected
Production
Test
```

Badge colors should follow the status tokens.

### 6.6 Empty States

Empty states must include:

```text
Short title
One-line explanation
Primary action
Optional secondary link to docs
```

Bad empty state:

```text
No data.
```

Good empty state:

```text
Create your first product
Products define what your customers can buy, including one-time payments, subscriptions, and credit packs.

[Create product] [View docs]
```

---

## 7. Page Guidelines

## 7.1 Overview

The Overview page is the project command center.

It should answer:

```text
Is revenue growing?
Are payments working?
Are subscriptions active?
Are credits being consumed?
Are payment providers healthy?
Is there anything I need to fix?
```

Recommended sections:

```text
Top KPI cards
Revenue chart
Payment status
Top products
Recent payments
Provider status
To-do list
Developer API callout
```

First-time empty state should become an onboarding checklist:

```text
1. Connect a payment provider
2. Create your first product
3. Add the SDK
4. Send your first event
5. Receive your first payment
```

---

## 7.2 Products

Products represent what developers sell.

Product types:

```text
One-time purchase
Subscription
Credit pack
Usage-based product
```

Products page should show:

```text
Product name
Product type
Price
Included credits
Active customers
Revenue
Status
```

Product creation should use a wizard instead of a long form.

Wizard steps:

```text
1. What are you selling?
2. Set pricing
3. Add credits or features
4. Choose payment provider
5. Review and create
```

---

## 7.3 Credits

Credits are a core feature.

The Credits page should explain and manage:

```text
Credit types
Credit balance
Issued credits
Consumed credits
Expiration
Reset rules
Rollover rules
Manual grants
```

Examples:

```text
Monthly Plan Credits
Purchased Credits
Bonus Credits
Manual Credits
```

Credit rules should be explicit:

```text
Reset monthly
Never expires
Expires in 30 days
No rollover
Rollover enabled
```

---

## 7.4 Payment Providers

Payment Providers are a core differentiation of MonetPlane.

This page should feel like a provider marketplace and configuration center.

Provider cards should show:

```text
Provider logo
Provider name
Supported payment methods
Best for
Connection status
Success rate
Action button
```

Examples:

```text
Stripe
Cards · Apple Pay
Connected

Lemon Squeezy
Merchant of Record
Not connected

Paddle
Merchant of Record
Not connected

Custom Provider
Use your own payment gateway
Configure
```

Provider metadata may include:

```text
Individual developer friendly
Company required
Global support
China support
Low-friction onboarding
Merchant of Record
```

This page should help developers answer:

```text
Which payment provider can I use?
Which one is best for my product?
What is already connected?
Is any provider unhealthy?
```

---

## 7.5 Customers

The Customers page should help developers inspect a customer's billing state.

Customer detail should include:

```text
Customer identity
Current plan
Credit balance
Entitlements
Payment history
Subscription history
Events
Manual actions
```

Important customer actions:

```text
Grant credits
Change plan
Cancel subscription
Retry payment
Refund payment
View events
```

---

## 7.6 Payments

The Payments page should show all payment transactions.

Important filters:

```text
Date range
Status
Product
Customer
Provider
Payment type
Amount range
Environment
```

Payment statuses:

```text
Succeeded
Failed
Processing
Refunded
Partially refunded
Canceled
```

Payment detail should show:

```text
Payment ID
Customer
Product
Amount
Provider
Provider transaction ID
Status
Timeline
Webhook delivery
Refunds
Logs
```

---

## 7.7 Subscriptions

Subscription pages should focus on recurring billing state.

Show:

```text
Customer
Plan
Billing period
Current period
Renewal date
Status
MRR
Provider
```

Statuses:

```text
Active
Trialing
Past due
Canceled
Paused
Expired
```

---

## 7.8 Developer

Developer pages should make integration feel fast and clear.

Developer section includes:

```text
API Keys
Events
Logs
Webhooks
SDK quickstart
```

API quickstart should include:

```text
Install SDK
Initialize client
Identify customer
Create checkout
Check entitlement
Track usage
```

Example:

```ts
const billing = new MonetPlane({
  apiKey: process.env.MONETPLANE_API_KEY,
})

await billing.checkout.create({
  customerId: "user_123",
  productId: "pro_monthly",
})
```

Developer pages should include connection status:

```text
API key created
Webhook configured
First event received
First payment received
```

---

## 8. Auth Product Boundary

MonetPlane should not become an Auth provider in V1.

The system should support customer identity through external auth systems.

Required concept:

```text
customer_id
```

Supported identity sources may include:

```text
Supabase Auth
Clerk
Better Auth
Firebase
Custom user database
```

MonetPlane should provide:

```text
Identify customer
Attach email
Attach metadata
Map external user ID to billing customer
```

But should not provide in V1:

```text
Password login
OAuth login
MFA
Session management
Organization auth
Role-based auth for end users
```

Auth integrations can be considered later.

---

## 9. Copywriting Tone

The product voice should be:

```text
Clear
Calm
Developer-friendly
Trustworthy
Action-oriented
```

Use plain language.

Prefer:

```text
Create your first product
Connect a payment provider
Start accepting payments
Grant credits
View payment events
```

Avoid:

```text
Supercharge your monetization
Revolutionize your billing
AI-powered payment magic
Unlock infinite revenue
```

The UI should sound like infrastructure, not marketing hype.

---

## 10. Do / Don't

### Do

```text
Use warm neutral colors.
Keep layout calm and readable.
Prioritize developer onboarding.
Show clear next actions.
Make payment state easy to understand.
Make provider status visible.
Use concise labels.
Use cards for summaries.
Use tables for operational records.
Use timelines for payment details.
```

### Don't

```text
Do not use high-saturation AI purple as the main UI color.
Do not use heavy blue-purple gradients.
Do not create large empty pages without guidance.
Do not hide payment providers under obscure menus.
Do not make the UI feel like a generic admin template.
Do not overload the Overview page with too many charts.
Do not use vague button labels.
Do not make Auth a core product in V1.
```

---

## 11. Implementation Notes

Recommended CSS variables:

```css
:root {
  --color-bg-page: #FAF8F5;
  --color-bg-sidebar: #F4F0EA;
  --color-bg-card: #FFFFFF;
  --color-bg-muted: #F7F4EF;
  --color-bg-hover: #EFEAE2;

  --color-border: #E8E2D8;
  --color-border-subtle: #F0ECE5;

  --color-text-primary: #111827;
  --color-text-secondary: #374151;
  --color-text-muted: #6B7280;
  --color-text-subtle: #9CA3AF;
  --color-text-inverse: #FFFFFF;

  --color-brand-primary: #111827;
  --color-brand-secondary: #6B5BB7;
  --color-brand-soft: #EFEAEF;
  --color-brand-hover: #0F172A;

  --color-success: #4F8F45;
  --color-success-bg: #EAF5E8;

  --color-warning: #D97706;
  --color-warning-bg: #FFF4E5;

  --color-danger: #DC4C3F;
  --color-danger-bg: #FDECEC;

  --color-info: #2F6FB2;
  --color-info-bg: #EAF2FB;

  --color-neutral: #6B7280;
  --color-neutral-bg: #F3F4F6;

  --chart-revenue: #2F2F2F;
  --chart-payments: #2F6FB2;
  --chart-success: #4F8F45;
  --chart-subscription: #6B5BB7;
  --chart-credits: #1F9AA5;
  --chart-warning: #D97706;
  --chart-danger: #DC4C3F;
}
```

Recommended UI rules:

```text
Use primary dark button for main actions.
Use warm neutral background for sidebar.
Use white cards with subtle borders.
Use status colors only for status.
Use purple only as small brand accent.
Keep charts readable and low-saturation.
```

---

## 12. Design Review Checklist

Before merging UI changes, check:

```text
[ ] Does this page follow the warm neutral direction?
[ ] Does this page avoid strong AI SaaS visual style?
[ ] Is the primary action clear?
[ ] Is the empty state useful?
[ ] Are payment states easy to understand?
[ ] Are provider states visible where relevant?
[ ] Are colors using defined tokens?
[ ] Are badges consistent?
[ ] Are charts readable and not overly colorful?
[ ] Does the page help developers move faster?
```

This document should be treated as the visual and interaction source of truth for MonetPlane.
