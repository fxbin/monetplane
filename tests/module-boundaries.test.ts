import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectTypeScriptFiles(fullPath);
      return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")
        ? [fullPath]
        : [];
    }),
  );

  return files.flat();
}

describe("module boundaries", () => {
  it("keeps provider adapters from mutating commerce, credits, or entitlements directly", async () => {
    const adaptersDirectory = path.join(
      process.cwd(),
      "src/modules/providers/adapters",
    );
    const files = await collectTypeScriptFiles(adaptersDirectory);

    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, `${file} imports commerce directly`).not.toMatch(
        /modules[\\/]commerce/,
      );
      expect(source, `${file} imports credits directly`).not.toMatch(
        /modules[\\/]credits/,
      );
      expect(source, `${file} imports entitlements directly`).not.toMatch(
        /modules[\\/]entitlements/,
      );
    }
  });

  it("keeps commerce free of concrete provider adapters", async () => {
    const commerceDirectory = path.join(process.cwd(), "src/modules/commerce");
    const files = await collectTypeScriptFiles(commerceDirectory);

    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, `${file} imports a concrete provider adapter`).not.toMatch(
        /providers[\\/]adapters/,
      );
      expect(source, `${file} contains provider-specific logic`).not.toMatch(
        PROVIDER_NAME_PATTERN,
      );
    }
  });

  it("keeps provider names out of every core billing domain (#72)", async () => {
    // A third provider must integrate without provider-name conditionals in
    // commerce/credits/entitlements; this pins that for every provider,
    // present and future.
    const coreDirectories = ["commerce", "credits", "entitlements"];
    for (const directory of coreDirectories) {
      const coreDirectory = path.join(process.cwd(), "src/modules", directory);
      const files = await collectTypeScriptFiles(coreDirectory);
      for (const file of files) {
        const source = await readFile(file, "utf8");
        expect(
          source,
          `${file} contains a provider-name conditional`,
        ).not.toMatch(PROVIDER_NAME_PATTERN);
      }
    }
  });
});

/**
 * Concrete provider names — extend this list when adding an adapter so the
 * boundary check grows with the ecosystem. Registration points that are
 * allowed to know providers (runtime.ts, setup.ts, adapters/) are outside
 * the scanned directories.
 */
const PROVIDER_NAME_PATTERN =
  /\b(creem|waffo|pancake|stripe|paddle|polar|paypal|lemonsqueezy|lemon[_ -]?squeezy|dodopayments|dodo[_ -]?payments|alipay|wechat[_ -]?pay|razorpay|mollie|square)\b/i;
