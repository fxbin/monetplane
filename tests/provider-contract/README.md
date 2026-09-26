# Provider adapter conformance kit

`adapter-contract.ts` exports `defineProviderAdapterContractTests` — the
shared contract suite every payment provider adapter must pass. It enforces
capability shape, normalized checkout/event outputs, webhook signature
rejection, stable event identity, and unknown-event handling, with no
network and no database.

To add a provider, follow [`docs/provider-adapter-guide.md`](../../docs/provider-adapter-guide.md)
and bind your adapter exactly like `creem-adapter.test.ts` /
`waffo-adapter.test.ts` do.
