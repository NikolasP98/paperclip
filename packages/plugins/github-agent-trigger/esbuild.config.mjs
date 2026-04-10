import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Bundle SDK for standalone deployment outside the monorepo
  external: [],
  sourcemap: true,
};

const configs = [
  { ...shared, entryPoints: ["src/worker.ts"], outfile: "dist/worker.js" },
  { ...shared, entryPoints: ["src/manifest.ts"], outfile: "dist/manifest.js" },
];

if (watch) {
  for (const cfg of configs) {
    const ctx = await context(cfg);
    await ctx.watch();
  }
  console.log("Watching for changes...");
} else {
  for (const cfg of configs) await build(cfg);
  console.log("Build complete.");
}
