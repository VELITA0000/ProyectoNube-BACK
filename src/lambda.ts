// `@codegenie/serverless-express` is a CommonJS package whose default export is
// the `configure` function. Under `module: NodeNext` we have to import the
// named `configure` re-export because the synthetic default mapping for
// CJS-from-ESM modules is not callable in TypeScript (runtime is fine).
import { configure } from "@codegenie/serverless-express";
import { createApp } from "./app.js";

const app = createApp();
export const handler = configure({ app });
