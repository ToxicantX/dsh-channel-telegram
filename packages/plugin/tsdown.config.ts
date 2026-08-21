import { defineConfig } from "tsdown";

const MODULE_ID = "dsh-channel-telegram";

export default defineConfig({
  entry: { client: "src/client/index.tsx" },
  outDir: "lib",
  format: "cjs",
  platform: "browser",
  dts: false,
  sourcemap: true,
  clean: false,
  hash: false,
  outExtensions: () => ({ js: ".js" }),
  external: [/^react(?:\/.*)?$/],
  deps: {
    neverBundle: (specifier) => specifier === "react" || specifier === "react/jsx-runtime",
    alwaysBundle: (specifier) => specifier !== "react" && specifier !== "react/jsx-runtime"
  },
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production") },
  plugins: [{
    name: "dsh-module-loader-wrapper",
    renderChunk(code, chunk) {
      if (!chunk.isEntry) return null;
      return {
        code: [
          "window.__ModuleLoader__.load({",
          "  id: " + JSON.stringify(MODULE_ID) + ",",
          "  factory: (require) => {",
          "    var module = { exports: {} };",
          "    var exports = module.exports;",
          code,
          "    return module.exports;",
          "  }",
          "});"
        ].join("\n"),
        map: null
      };
    }
  }]
});
