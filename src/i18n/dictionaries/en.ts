/**
 * English dictionary — the SOURCE OF TRUTH for the console UI vocabulary.
 *
 * Shape rules (i18n decision, 2026-10-04):
 *  - Plain nested objects of string leaves only (no arrays/numbers) so the
 *    zh translation can be type-checked as `Dictionary` — a missing or
 *    extra key in any locale is a compile error, not a runtime blank.
 *  - Interpolation uses `{placeholder}` tokens replaced at the call site.
 *  - This initial migration covers the app shell, login, and the overview
 *    page; remaining pages migrate on the touch rule (see the agent note).
 */
export const en = {
  common: {
    sandbox: "Sandbox",
    production: "Production",
  },
  locale: {
    label: "Language",
  },
  nav: {
    brandSubtitle: "Billing control plane",
    manageProjects: "Manage projects",
    soon: "Soon",
    settings: "Settings",
    preview: "P1 Console preview",
    sections: {
      products: "Products",
      business: "Business",
      analytics: "Analytics",
      integrations: "Integrations",
      developer: "Developer",
      workspace: "Workspace",
    },
    items: {
      overview: "Overview",
      products: "Products",
      credits: "Credits",
      features: "Features",
      customers: "Customers",
      payments: "Payments",
      subscriptions: "Subscriptions",
      refunds: "Refunds",
      revenue: "Revenue",
      usage: "Usage",
      providers: "Payment Providers",
      webhooks: "Webhooks",
      quickstart: "Quickstart",
      apiKeys: "API Keys",
      events: "Events",
      logs: "Logs",
      auditLog: "Audit Log",
      projects: "Projects",
      team: "Team",
    },
    aria: {
      applicationContext: "Application context",
    },
  },
  topbar: {
    environment: "Environment",
    noProject: "No project",
    operator: "Operator",
  },
  projectSwitcher: {
    switching: "Switching…",
    noApplications: "No applications",
    createProject: "Create project",
    scopedData: "Application-scoped console data",
    ariaCurrentProject: "Current project",
  },
  login: {
    subtitle: "Operator console",
    email: "Email",
    emailPlaceholder: "operator@yourcompany.com",
    password: "Password",
    passwordPlaceholder: "Enter your password",
    submit: "Sign in",
    invalidCredentials: "Invalid email or password",
  },
  overview: {
    title: "Overview",
    description: "{application} · {environment} billing health and activity.",
    emptyDescription:
      "Create a project to start configuring your billing control plane.",
    emptyTitle: "Create your first project",
    emptyDesc:
      "A project represents one product or website using MonetPlane and keeps its billing data isolated.",
    createProjectStep: "Create a project",
    connectProvider: "Connect provider",
    kpiRevenue: "Revenue ({environment})",
    kpiPayments: "Payments",
    kpiActiveSubscriptions: "Active subscriptions",
    kpiCreditsGranted: "Credits granted",
    kpiCreditsUsed: "Credits used",
    checklistDone: "Billing is fully connected",
    checklistPending: "Finish setting up billing",
    next: "Next:",
    providerHealthTitle: "Provider health · {environment}",
    thProvider: "Provider",
    thConnection: "Connection",
    thStatus: "Status",
    noProvidersBefore: "No providers connected in {environment}. ",
    noProvidersLink: "Connect one",
    noProvidersAfter: " to enable checkout.",
    topProducts: "Top products",
    thProduct: "Product",
    thUnits: "Units",
    thRevenue: "Revenue",
    noProductsBefore: "No paid orders yet. ",
    noProductsLink: "Create a product",
    noProductsAfter: " to get started.",
    recentPayments: "Recent payments",
    thPayment: "Payment",
    thCustomer: "Customer",
    thAmount: "Amount",
    thDate: "Date",
    noPaymentsYet: "No payments recorded in this environment yet.",
    firstPayment: "Run a Sandbox checkout to see your first payment here.",
    linkRevenue: "Revenue",
    linkRevenueDesc: "Monthly revenue and product breakdown",
    linkUsage: "Usage",
    linkUsageDesc: "Credit consumption by type and customer",
    linkDeveloper: "Developer",
    linkDeveloperDesc: "Quickstart, API keys, integration health",
  },
};

export type Dictionary = typeof en;
