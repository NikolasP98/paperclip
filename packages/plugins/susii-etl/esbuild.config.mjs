import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Bundle deps so the plugin can run from the docker-cp deploy path that
  // doesn't have its own node_modules. `postgres` is the only runtime dep.
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
