import { describe, expect, it } from "vitest";
import {
  readProductBuilderType,
  readProductProviderRoute,
} from "../src/server/control-plane/products";

describe("product builder metadata", () => {
  it("reads the product presentation type", () => {
    expect(
      readProductBuilderType({
        monetplane: { productType: "credit_pack" },
      }),
    ).toBe("credit_pack");
  });

  it("rejects unknown product presentation types", () => {
    expect(
      readProductBuilderType({
        monetplane: { productType: "metered_magic" },
      }),
    ).toBeNull();
  });

  it("keeps provider routing environment-specific", () => {
    const metadata = {
      monetplane: {
        providerRouting: {
          test: "pconn_test",
          live: "pconn_live",
        },
      },
    };

    expect(readProductProviderRoute(metadata, "test")).toBe("pconn_test");
    expect(readProductProviderRoute(metadata, "live")).toBe("pconn_live");
  });

  it("does not invent a route when metadata is missing", () => {
    expect(readProductProviderRoute({}, "test")).toBeNull();
  });
});
