import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  headerValue,
  isRecord,
  numberValue,
  optionalString,
  parseWebhookJson,
  providerBaseUrl,
  providerErrorMessage,
  providerFetchJson,
  recordValue,
  requiredCredential,
  stringValue,
} from "../src/modules/providers/adapters/shared";
import type { ProviderConnectionContext } from "../src/modules/providers/contract";
import { ProviderOperationError } from "../src/modules/providers/contract";

const connection = (credentials: Record<string, string>) =>
  ({
    id: "pc_shared",
    applicationId: "app_shared",
    provider: "paypal",
    mode: "test",
    metadata: {},
    credentials,
  }) satisfies ProviderConnectionContext;

describe("provider adapter shared kit (audit A8)", () => {
  describe("JSON guards", () => {
    it("isRecord accepts plain objects and rejects arrays/primitives/null", () => {
      expect(isRecord({})).toBe(true);
      expect(isRecord({ a: 1 })).toBe(true);
      expect(isRecord([])).toBe(false);
      expect(isRecord("x")).toBe(false);
      expect(isRecord(42)).toBe(false);
      expect(isRecord(null)).toBe(false);
      expect(isRecord(undefined)).toBe(false);
    });

    it("stringValue returns non-empty strings; trim-empty -> undefined", () => {
      expect(stringValue("hello")).toBe("hello");
      expect(stringValue("")).toBeUndefined();
      expect(stringValue("   ")).toBeUndefined();
      expect(stringValue(42)).toBeUndefined();
      expect(stringValue(null)).toBeUndefined();
    });

    it("optionalString trims surrounding whitespace and collapses to undefined", () => {
      expect(optionalString("  padded  ")).toBe("padded");
      expect(optionalString("   ")).toBeUndefined();
      expect(optionalString("")).toBeUndefined();
      expect(optionalString(7)).toBeUndefined();
    });

    it("numberValue accepts finite numbers only", () => {
      expect(numberValue(3)).toBe(3);
      expect(numberValue(-1.5)).toBe(-1.5);
      expect(numberValue(Number.NaN)).toBeUndefined();
      expect(numberValue(Number.POSITIVE_INFINITY)).toBeUndefined();
      expect(numberValue("3")).toBeUndefined();
    });

    it("recordValue narrows objects, rejects everything else", () => {
      const value: unknown = { nested: true };
      expect(recordValue(value)).toBe(value);
      expect(recordValue([1])).toBeUndefined();
      expect(recordValue("obj")).toBeUndefined();
    });

    it("headerValue resolves exact and case-insensitive header names", () => {
      const headers = { "PayPal-Transmission-Id": "TRX-1" };
      expect(headerValue(headers, "PayPal-Transmission-Id")).toBe("TRX-1");
      expect(headerValue(headers, "paypal-transmission-id")).toBe("TRX-1");
      expect(headerValue(headers, "paypal-auth-algo")).toBeUndefined();
    });
  });

  describe("requiredCredential", () => {
    it("returns the trimmed credential when present", () => {
      expect(
        requiredCredential(
          connection({ clientId: "  CID_1  " }),
          "clientId",
          "PayPal",
        ),
      ).toBe("CID_1");
    });

    it("throws the classified ProviderOperationError('rejected') when missing (intentional unification)", () => {
      for (const credentials of [{}, { clientId: "   " }] as Array<
        Record<string, string>
      >) {
        try {
          requiredCredential(connection(credentials), "clientId", "PayPal");
          throw new Error("expected requiredCredential to throw");
        } catch (error) {
          expect(error).toBeInstanceOf(ProviderOperationError);
          const classified = error as ProviderOperationError;
          expect(classified.failureKind).toBe("rejected");
          expect(classified.message).toBe(
            "PayPal connection is missing the clientId credential",
          );
        }
      }
    });

    it("supports a pluggable error class", () => {
      class CustomError extends Error {
        constructor(
          message: string,
          public readonly failureKind: "rejected" | "outcome_uncertain",
        ) {
          super(message);
        }
      }
      expect(() =>
        requiredCredential(
          connection({}),
          "apiKey",
          "Creem",
          CustomError as never,
        ),
      ).toThrow(CustomError);
    });
  });

  describe("providerBaseUrl", () => {
    const official = {
      test: "https://api.test.example/",
      live: "https://api.live.example",
    };

    it("uses the official URL for the mode and strips trailing slashes", () => {
      expect(providerBaseUrl(connection({}), official)).toBe(
        "https://api.test.example",
      );
      const liveConnection = {
        ...connection({}),
        mode: "live" as const,
      } satisfies ProviderConnectionContext;
      expect(providerBaseUrl(liveConnection, official)).toBe(
        "https://api.live.example",
      );
    });

    it("prefers the configured override", () => {
      expect(
        providerBaseUrl(connection({}), official, {
          test: "https://creem.test",
        }),
      ).toBe("https://creem.test");
    });
  });

  describe("providerErrorMessage", () => {
    it("extracts message, details[0].description, error_description, then error", () => {
      expect(providerErrorMessage({ message: "m" }, "fb")).toBe("m");
      expect(
        providerErrorMessage({ details: [{ description: "d" }] }, "fb"),
      ).toBe("d");
      expect(providerErrorMessage({ error_description: "ed" }, "fb")).toBe(
        "ed",
      );
      expect(providerErrorMessage({ error: "e" }, "fb")).toBe("e");
      expect(
        providerErrorMessage({ error: { description: "obj" } }, "fb"),
      ).toBe("obj");
    });

    it("falls back to the provider-prefixed fallback", () => {
      expect(providerErrorMessage({}, "PayPal request failed (500)")).toBe(
        "PayPal request failed (500)",
      );
    });
  });

  describe("providerFetchJson", () => {
    it("returns status, statusText, and the parsed JSON object payload", async () => {
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ id: "ORDER_1", ok: true }), {
          status: 201,
          statusText: "Created",
        })) as typeof fetch;
      const result = await providerFetchJson(
        "https://api.test.example/v1/x",
        undefined,
        { provider: "PayPal", fetchImpl },
      );
      expect(result.status).toBe(201);
      expect(result.statusText).toBe("Created");
      expect(result.payload).toEqual({ id: "ORDER_1", ok: true });
    });

    it("throws a provider-prefixed error on invalid JSON (parse error path)", async () => {
      const fetchImpl = (async () =>
        new Response("<html>gateway error</html>", {
          status: 502,
          statusText: "Bad Gateway",
        })) as typeof fetch;
      await expect(
        providerFetchJson("https://api.test.example/v1/x", undefined, {
          provider: "Creem",
          fetchImpl,
        }),
      ).rejects.toThrow("Creem returned invalid JSON (502 Bad Gateway)");
    });

    it("throws on JSON bodies that are not objects", async () => {
      const fetchImpl = (async () =>
        new Response(JSON.stringify([1, 2, 3]), {
          status: 200,
        })) as typeof fetch;
      await expect(
        providerFetchJson("https://api.test.example/v1/x", undefined, {
          provider: "PayPal",
          fetchImpl,
        }),
      ).rejects.toThrow("PayPal returned invalid JSON (200)");
    });

    it("surfaces an AbortError within the configured timeout (audit M1)", async () => {
      // A fetch that hangs forever but honors the abort signal — mirrors
      // real fetch behavior when AbortSignal.timeout fires.
      const hangingFetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        })) as typeof fetch;

      const started = Date.now();
      await expect(
        providerFetchJson("https://api.test.example/v1/slow", undefined, {
          provider: "PayPal",
          timeoutMs: 25,
          fetchImpl: hangingFetch,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("defaults the timeout when none is configured", () => {
      expect(DEFAULT_PROVIDER_TIMEOUT_MS).toBe(10_000);
    });

    it("keeps a caller-provided signal instead of the timeout signal", async () => {
      const observed: Array<AbortSignal | null | undefined> = [];
      const fetchImpl = ((_url: RequestInfo | URL, init?: RequestInit) => {
        observed.push(init?.signal);
        return Promise.resolve(
          new Response(JSON.stringify({}), { status: 200 }),
        ) as Promise<Response>;
      }) as typeof fetch;
      const controller = new AbortController();
      await providerFetchJson(
        "https://api.test.example/v1/x",
        { signal: controller.signal },
        {
          provider: "PayPal",
          fetchImpl,
        },
      );
      expect(observed[0]).toBe(controller.signal);
    });
  });

  describe("parseWebhookJson", () => {
    it("parses a valid JSON object", () => {
      expect(parseWebhookJson('{"id":"WH-1"}', "PayPal")).toEqual({
        id: "WH-1",
      });
    });

    it("throws provider-labeled errors for invalid JSON and non-object bodies", () => {
      expect(() => parseWebhookJson("not json", "PayPal")).toThrow(
        "PayPal webhook body is not valid JSON",
      );
      expect(() => parseWebhookJson("[1,2]", "PayPal")).toThrow(
        "PayPal webhook must be a JSON object",
      );
      expect(() => parseWebhookJson('"str"', "Waffo Pancake")).toThrow(
        "Waffo Pancake webhook must be a JSON object",
      );
    });
  });

  it("keeps the adapters directory free of next/react imports (module boundary)", async () => {
    const adaptersDirectory = path.join(
      process.cwd(),
      "src/modules/providers/adapters",
    );
    const files = (await readdir(adaptersDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => path.join(adaptersDirectory, entry.name));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, `${file} imports next/react`).not.toMatch(
        /from\s+["'](next|react)[/"']/,
      );
    }
  });
});
