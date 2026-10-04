import { describe, expect, it } from "vitest";
import { classifyHttpFailure } from "../../src/modules/providers/adapters/shared";
import { ProviderOperationError } from "../../src/modules/providers/contract";

/**
 * Shared HTTP failure classification (roundtable batch 1). The three
 * adapters previously disagreed: PayPal only classified 400/422, Creem
 * classified nothing as rejected (operators could never retry a
 * deterministic Creem failure), and Waffo treated status 0 as rejected.
 * Every adapter now routes HTTP failures through this single rule, and
 * `retryBillingOperation` (which only allows retries after "rejected")
 * depends on it staying honest.
 */
describe("classifyHttpFailure", () => {
  it("classifies 4xx as deterministic, retryable-after-fix rejections", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      const error = classifyHttpFailure(status, "boom");
      expect(error).toBeInstanceOf(ProviderOperationError);
      expect(error.failureKind).toBe("rejected");
      expect(error.message).toBe("boom");
    }
  });

  it("classifies 5xx as outcome-uncertain so the journal never blind-retries", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyHttpFailure(status, "upstream").failureKind).toBe(
        "outcome_uncertain",
      );
    }
  });

  it("classifies unknown statuses (0/network) as outcome-uncertain", () => {
    // Waffo previously mapped status 0 (network-level SDK error) to
    // "rejected", which would have allowed a blind retry.
    expect(classifyHttpFailure(0, "network").failureKind).toBe(
      "outcome_uncertain",
    );
  });
});
