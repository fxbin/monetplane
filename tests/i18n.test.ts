import { describe, expect, it } from "vitest";
import { en } from "../src/i18n/dictionaries/en";
import { zh } from "../src/i18n/dictionaries/zh";
import { formatMessage, resolveLocale } from "../src/i18n/server";

/**
 * Dictionary parity is enforced at compile time (`zh: Dictionary`), but a
 * runtime check documents the contract and would catch any future `as`
 * escape hatch. Interpolation and locale resolution are the runtime
 * behaviors worth pinning.
 */

function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, nested]) =>
    leafKeys(nested, prefix ? `${prefix}.${key}` : key),
  );
}

describe("i18n dictionaries", () => {
  it("keeps zh and en key trees identical", () => {
    expect(leafKeys(zh)).toEqual(leafKeys(en));
  });

  it("has no empty translations", () => {
    const empty = leafKeys(zh).filter((path) => {
      const value = path
        .split(".")
        .reduce<unknown>(
          (node, key) => (node as Record<string, unknown>)?.[key] as unknown,
          zh,
        );
      return typeof value !== "string" || value.trim().length === 0;
    });
    expect(empty).toEqual([]);
  });

  it("interpolates {placeholder} tokens", () => {
    expect(
      formatMessage("{environment} 中尚未连接支付渠道。", {
        environment: "沙箱",
      }),
    ).toBe("沙箱 中尚未连接支付渠道。");
    expect(formatMessage("no tokens", {})).toBe("no tokens");
  });

  it("resolves locales fail-safe: only zh switches, everything else is en", () => {
    expect(resolveLocale("zh")).toBe("zh");
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale("fr")).toBe("en");
    expect(resolveLocale("ZH")).toBe("en");
  });
});
