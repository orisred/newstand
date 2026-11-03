import { readFile } from "node:fs/promises";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));

  return {
    plugins: [
      // Vite can't import a .wasm file as a compiled module, and workerd only
      // compiles one at runtime through an unsafe-eval binding. The plugin keeps
      // its own under this internal name and overrides any other, so a plugin
      // upgrade can rename it; the Prisma tests fail loudly if that happens.
      {
        name: "prisma-query-compiler",
        enforce: "pre" as const,
        async load(id: string) {
          if (!id.endsWith("query_compiler_bg.wasm?module")) return null;
          const wasm = await readFile(id.slice(0, -"?module".length), "base64");
          return `import { env } from "cloudflare:workers";
export default env.__VITEST_POOL_WORKERS_UNSAFE_EVAL.newWasmModule(Uint8Array.from(atob("${wasm}"), (c) => c.charCodeAt(0)));`;
        },
      },
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2026-11-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          kvNamespaces: ["SESSIONS"],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: { include: ["tests/**/*.test.ts"] },
  };
});
