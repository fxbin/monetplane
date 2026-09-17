# P1 Console Architecture

How the control-plane console is layered after the P1 frontend cleanup
(#44). This complements [architecture.md](./architecture.md), which
covers the P0 backend modules.

## Layering rules

Dependency direction is strictly downward:

```text
src/app/**                 Next.js routes / server components
  → src/components/**      console UI (layout, features, ui primitives)
  → src/server/control-plane/**   UI/application orchestration (reads + commands)
    → src/modules/**       billing domain boundaries (UI-agnostic)
      → src/db/**          schema + client
```

- `src/modules/*` must stay UI-agnostic: no React, no Next.js imports, no
  console-specific filters or view models. Domain modules expose services
  and schemas only.
- UI-oriented reads and command orchestration live in
  `src/server/control-plane/*` (e.g. `context.ts`, `products.ts`,
  `developer.ts`, `overview.ts`, `console-queries.ts`). This is where
  environment scoping, view shaping, and page aggregation happen.
- `src/app/(dashboard)/**` pages are thin server components: they call one
  or two control-plane functions and render.
- `src/sdk` remains the public integration contract and never imports
  console internals.

## Console UI primitives

`src/components/ui/console.tsx` and `src/components/ui/DataTable.tsx` are
the canonical primitives:

- `StatusBadge` — renders `badge badge-<status>` with the shared status
  vocabulary from `globals.css`. Do not hand-roll badge spans.
- `EmptyState` — shared empty/first-run block. Pages with rich guided
  content pass children.
- `DataTable` — typed column/row wrapper around the shared `.data-table`
  styles.

New console pages must reuse these instead of duplicating markup.
Existing pages migrate opportunistically; the shared `.data-table` /
`.card` / `.stat-card` CSS classes remain the base design system.

## Admin API surface

- `/api/admin/*` routes authenticate with the Auth.js session guard
  (`src/modules/admin/guard.ts`) and delegate to control-plane functions.
- Console read queries moved from `src/modules/admin/queries.ts` to
  `src/server/control-plane/console-queries.ts`; `src/modules/admin` now
  only holds the API session guard.

## Conventions

- Loading/empty/error states: server components render `EmptyState` for
  empty data; mutation feedback stays in the small client components
  (`src/components/**`) that own forms and confirmations.
- Environment semantics: any control-plane read that touches provider
  connections accepts the console environment and scopes by
  `providerConnections.mode` (see `developer.ts`, `overview.ts`).
- Credits remain project-wide (no mode column); UI copy must label this.
