import express from "express";
import cors from "cors";
import { getEnv } from "./config/env.js";
import { sendError } from "./http/errors.js";
import { emitEmfCount } from "./observability/emf.js";
import { requestCountMetricsMiddleware } from "./middleware/requestMetrics.js";
import { authRouter } from "./routes/auth.js";
import { portfoliosRouter } from "./routes/portfolios.js";
import { photosRouter } from "./routes/photos.js";
import { cartRouter } from "./routes/cart.js";
import { purchasesRouter } from "./routes/purchases.js";
import { photographerRouter } from "./routes/photographer.js";
import { stripeWebhookHandler } from "./routes/webhooks.js";

/**
 * Express app without `listen`; used locally (`index.ts`) and on Lambda (`lambda.ts`).
 */
export function createApp(): express.Express {
  const app = express();

  app.use(requestCountMetricsMiddleware);

  app.get("/health", (_req, res) => {
    try {
      emitEmfCount({ HealthCheckCount: 1 }, { Service: "api", Endpoint: "health" });
    } catch {
      /* seguir sirviendo health aunque falle el log EMF */
    }
    res.json({ ok: true });
  });

  let envLoaded = false;
  try {
    getEnv();
    envLoaded = true;
  } catch (err) {
    console.warn(
      "[API] Incomplete environment: GET /health only. Check env vars —",
      err instanceof Error ? err.message : err,
    );
  }

  if (envLoaded) {
    app.post("/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhookHandler);

    app.use(
      cors({
        origin: getEnv().FRONTEND_ORIGIN,
        credentials: true,
        allowedHeaders: ["Authorization", "Content-Type"],
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      }),
    );
    app.use(express.json());

    app.use("/auth", authRouter);
    app.use("/portfolios", portfoliosRouter);
    app.use("/photos", photosRouter);
    app.use("/cart", cartRouter);
    app.use("/purchases", purchasesRouter);
    app.use("/photographer", photographerRouter);

    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      sendError(res, err);
    });
  } else {
    app.use((_req, res) => {
      res.status(503).json({ code: "not_ready", message: "Configure the environment and restart for other routes." });
    });
  }

  return app;
}
