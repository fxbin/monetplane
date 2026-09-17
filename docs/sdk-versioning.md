# MonetPlane SDK Versioning & Compatibility Policy

Scope: the published `@monetplane/sdk` package (source: `src/sdk`, built by
`packages/sdk`).

## Package layout

- `@monetplane/sdk` — error hierarchy and shared types (`dist/index.js`)
- `@monetplane/sdk/server` — `createMonetPlaneClient` and the server-only
  client (`dist/server.js`). **Server-only**: it carries the app secret and
  must never be imported into browser/client code.

The SDK is dependency-free (global `fetch`, Node 22+). No provider SDK is
ever imported — the surface is provider-neutral by contract and by test
(`tests/sdk/packaging-contract.test.ts`, `tests/sdk/sdk-contract.test.ts`).

## Versioning (semver)

- **MAJOR**: breaking client-shape changes — removed/renamed methods or
  types, changed request/response field semantics, or a server-side
  behavior change that cannot be expressed compatibly (e.g. the planned
  hard-fail of omitted `environment` on runtime mutations, tracked as the
  deprecation-window flip).
- **MINOR**: additive methods/types, new optional fields, new typed error
  subclasses.
- **PATCH**: fixes that preserve shapes.

Until `1.0.0` (v0.x): breaking changes may land in MINOR bumps but must be
called out in the release notes with a migration path.

## Compatibility windows

The server may run one MAJOR version behind the SDK. Deprecations (e.g.
omitting `environment`) follow this sequence:

1. SDK documents the field as required; server accepts omission with a
   logged deprecation warning (current state for credits/entitlements).
2. On the next SDK MAJOR, the server starts rejecting the omitted field
   with `400`; the error maps to `ValidationError` in the SDK.

## Typed error surface

Provider-neutral errors live in `@/sdk/errors` and map from server `code`
values: `AuthorizationError` (`unauthorized`), `InsufficientCreditsError`
(`insufficient_credits`), `UnsupportedCapabilityError`
(`unsupported_capability`), `NoProviderRouteError` (`no_provider_route`),
`UsageMeterNotFoundError` (`meter_not_found`), `ValidationError`
(`invalid_request`, `environment_mismatch`), `InvalidStateError`
(`invalid_state`), `NetworkError`, and generic `ApiError` otherwise.

## Contract guarantees

- `tests/sdk/sdk-contract.test.ts` pins request/response shapes against a
  mocked transport.
- `tests/sdk/packaging-contract.test.ts` fails when an SDK method loses
  its server route (drift guard) or when the package export map breaks.
- Example applications under `examples/` compile against the packaged
  artifact only (no MonetPlane source imports) and run in CI.

## Release process (design; publishing is intentionally not enabled)

1. `pnpm sdk:build` — compile `packages/sdk` to `dist/`.
2. `pnpm sdk:pack` — produce the tarball artifact.
3. `pnpm sdk:verify` — install into both examples and typecheck them.
4. Publishing to a registry requires release ownership + credentials to be
   configured explicitly (tracked separately); do not publish from CI by
   default.
