import { createApp } from "./app.js";
import { getEnv } from "./config/env.js";

const app = createApp();
const port = Number(process.env.PORT) || 4000;

let envLoaded = false;
try {
  getEnv();
  envLoaded = true;
} catch {
  envLoaded = false;
}

app.listen(port, () => {
  if (envLoaded) {
    console.log(`API listening on http://localhost:${port}`);
  } else {
    console.log(`API (GET /health only) on http://localhost:${port}`);
  }
});
