const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  format: "cjs",
  platform: "node",
  target: "node18",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info"
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("[esbuild] watching for changes...");
  } else {
    await esbuild.build(options);
    console.log("[esbuild] build complete");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
