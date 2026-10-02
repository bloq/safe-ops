import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "hardhat/index": "src/hardhat/index.ts" },
  format: ["esm", "cjs"],
  // tsup injects `baseUrl`, which TypeScript 6 deprecates.
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  sourcemap: true,
  clean: true,
  target: "node22",
});
