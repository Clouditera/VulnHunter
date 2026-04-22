import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/bundle.js",
  external: [],
  // ws uses dynamic require — we need CJS compat for bundling
  banner: {
    js: `
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
`,
  },
  sourcemap: true,
  minify: false,
});

console.log("worker-bridge built → dist/bundle.js");
