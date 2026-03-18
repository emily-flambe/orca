import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/cli/index.ts"],
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    clean: true,
    splitting: false,
    sourcemap: true,
    dts: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  {
    entry: { "mcp-server": "src/mcp-server/index.ts" },
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    clean: false,
    splitting: false,
    sourcemap: true,
    dts: false,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
