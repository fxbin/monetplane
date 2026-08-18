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
      expect(source, `${file} contains Creem-specific logic`).not.toMatch(
        /\bcreem\b/i,
      );
      expect(source, `${file} contains Waffo-specific logic`).not.toMatch(
        /\bwaffo\b/i,
      );
    }
  });
});
