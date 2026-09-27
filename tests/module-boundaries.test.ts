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

  it("keeps dashboard pages and components off module services (layering)", async () => {
    // Documented layering (docs/p1-console-architecture.md):
    // app/(dashboard) + components -> server/control-plane -> modules -> db.
    // `import type` is always fine. Any value import from the module layer
    // needs an entry in UI_MODULE_IMPORT_ALLOWLIST — each entry is a
    // reviewed decision, not an invitation.
    const uiDirectories = [
      path.join(process.cwd(), "src/app/(dashboard)"),
      path.join(process.cwd(), "src/components"),
    ];

    for (const directory of uiDirectories) {
      const files = await collectTypeScriptFiles(directory);
      for (const file of files) {
        const relative = path.relative(process.cwd(), file);
        const source = await readFile(file, "utf8");
        const moduleImports = [
          ...source.matchAll(
            /import\s+(type\s+)?[^;]*?from\s+"@(\/modules\/[^"]+)"/g,
          ),
        ];
        for (const match of moduleImports) {
          const [, typeMarker, modulePath] = match;
          if (typeMarker) continue;
          const allowed = UI_MODULE_IMPORT_ALLOWLIST.some(
            (entry) =>
              relative === entry.file && modulePath.startsWith(entry.module),
          );
          expect(
            allowed,
            `${relative} imports ${modulePath} from the module layer directly — route it through src/server/control-plane or add a reviewed allowlist entry`,
          ).toBe(true);
        }
      }
    }
  });

  it("keeps domain modules free of framework imports", async () => {
    // Domain modules own business rules and must stay runnable outside
    // Next.js (integration tests import them directly). A module that is
    // genuinely web middleware needs a FRAMEWORK_IMPORT_ALLOWLIST entry
    // plus a follow-up to relocate it.
    const modulesDirectory = path.join(process.cwd(), "src/modules");
    const files = await collectTypeScriptFiles(modulesDirectory);

    for (const file of files) {
      const relative = path.relative(process.cwd(), file);
      const source = await readFile(file, "utf8");
      const frameworkImports = [
        ...source.matchAll(
          /import\s+(type\s+)?[^;]*?from\s+"(next\/[^"]*|react(?:\/[^"]*)?)"/g,
        ),
      ];
      for (const match of frameworkImports) {
        const [, typeMarker, modulePath] = match;
        if (typeMarker) continue;
        const allowed = FRAMEWORK_IMPORT_ALLOWLIST.includes(relative);
        expect(
          allowed,
          `${relative} imports "${modulePath}" — domain modules must not depend on the web framework`,
        ).toBe(true);
      }
    }
  });

  it("keeps control-plane off concrete provider adapters", async () => {
    // The control plane reaches providers through runtime.ts/contract.ts
    // only; concrete adapters belong to the registry facade.
    const controlPlaneDirectory = path.join(
      process.cwd(),
      "src/server/control-plane",
    );
    const files = await collectTypeScriptFiles(controlPlaneDirectory);

    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, `${file} imports a concrete provider adapter`).not.toMatch(
        /providers[\\/]adapters/,
      );
    }
  });
});

// Value imports from the module layer that the UI layer is allowed to make.
// Sidebar gates navigation on session/permission helpers (no data access);
// ProviderConnectForm consumes static credential-form metadata (no I/O).
const UI_MODULE_IMPORT_ALLOWLIST = [
  {
    file: "src/components/layout/Sidebar.tsx",
    module: "/modules/admin/guard",
  },
  {
    file: "src/components/layout/Sidebar.tsx",
    module: "/modules/team/permissions",
  },
  {
    file: "src/components/providers/ProviderConnectForm.tsx",
    module: "/modules/providers/setup",
  },
];

// Web-middleware modules inside src/modules. admin/guard returns
// NextResponse for route guards; relocating it out of modules is a
// documented follow-up (audit C2).
const FRAMEWORK_IMPORT_ALLOWLIST = ["src/modules/admin/guard.ts"];

/**
 * Concrete provider names — extend this list when adding an adapter so the
 * boundary check grows with the ecosystem. Registration points that are
 * allowed to know providers (runtime.ts, setup.ts, adapters/) are outside
 * the scanned directories.
 */
const PROVIDER_NAME_PATTERN =
  /\b(creem|waffo|pancake|stripe|paddle|polar|paypal|lemonsqueezy|lemon[_ -]?squeezy|dodopayments|dodo[_ -]?payments|alipay|wechat[_ -]?pay|razorpay|mollie|square)\b/i;
