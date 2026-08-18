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
  it("keeps provider adapters from mutating credits or entitlements directly", async () => {
    const providersDirectory = path.join(
      process.cwd(),
      "src/modules/providers",
    );
    const files = await collectTypeScriptFiles(providersDirectory);

    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, `${file} imports credits directly`).not.toContain(
        "@/modules/credits",
      );
      expect(source, `${file} imports entitlements directly`).not.toContain(
        "@/modules/entitlements",
      );
    }
  });
});
