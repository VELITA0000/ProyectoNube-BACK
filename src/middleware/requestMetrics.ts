import type { Request, Response, NextFunction } from "express";
import { emitEmfCount } from "../observability/emf.js";

/**
 * Cuenta cada respuesta HTTP terminada (Lambda API) para volumen y alarmas de tráfico mínimo.
 */
export function requestCountMetricsMiddleware(_req: Request, res: Response, next: NextFunction): void {
  res.on("finish", () => {
    try {
      emitEmfCount({ ApiRequestCount: 1 }, { Service: "api" });
    } catch {
      /* no bloquear respuesta por métricas */
    }
  });
  next();
}
