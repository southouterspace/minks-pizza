import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const SERVER_ONLY = "Server-only module. Shared types and pure rules live in orders.ts, reports.ts and the other pure modules.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The client boundary. Server modules don't carry `import "server-only"`
  // because the tsx domain and e2e scripts import them under plain Node,
  // where that marker can't resolve; this rule keeps them out of client and
  // pure shared code instead.
  {
    files: [
      "src/components/**",
      "src/lib/pos-client/**",
      "src/lib/pos-outbox.ts",
      "src/lib/{orders,reports,pricing,kds,validation,money,store-time,hours,utils}.ts",
      "src/lib/use-*.ts",
    ],
    rules: {
      // Type-only imports are erased at build time, so a component may name a server module's types.
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: ["@/db", "@/lib/auth", "@/lib/staff", "@/lib/pin"].map((name) => ({ name, message: SERVER_ONLY, allowTypeImports: true })),
          patterns: [{ group: ["@/lib/*-server", "@/lib/*-server/*"], message: SERVER_ONLY, allowTypeImports: true }],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
