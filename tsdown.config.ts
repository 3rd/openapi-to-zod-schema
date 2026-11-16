import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: "src/index.ts",
    format: ["esm", "cjs"],
    platform: "neutral",
    target: "es2016",
    minify: true,
    sourcemap: true,
    dts: { generator: "oxc" },
    outExtensions: ({ format }) => {
      if (format === "es") return { js: ".mjs", dts: ".d.ts" };
      return undefined;
    },
  },
  {
    entry: { cli: "src/bin.ts" },
    format: "esm",
    platform: "node",
    target: "node24.11.1",
    minify: true,
    sourcemap: true,
    dts: false,
    deps: { alwaysBundle: ["yaml"], onlyBundle: ["yaml"], neverBundle: ["zod"] },
  },
]);
