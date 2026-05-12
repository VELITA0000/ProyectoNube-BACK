import * as esbuild from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, ".lambda-build");
const outfile = join(outDir, "index.js");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [join(root, "src", "lambda.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile,
  logLevel: "info",
  banner: {
    js: "/* bundle API Lambda */",
  },
  // No `footer` here. esbuild already emits `module.exports = __toCommonJS(lambda_exports)`
  // which exposes `handler` as a getter-backed property; Lambda calls it correctly. A
  // previous version of this script appended `module.exports.handler = handler` thinking
  // the export was missing, but that line crashed at module load with
  // "TypeError: Cannot set property handler of #<Object> which has only a getter".
});

console.log("OK:", outfile);
