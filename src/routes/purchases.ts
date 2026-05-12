import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { HttpError } from "../http/errors.js";
import { getPool } from "../db/pool.js";
import { mapPurchase } from "../domain/mappers.js";

export const purchasesRouter = Router();

purchasesRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.query.clientId as string | undefined;
    if (!clientId) throw new HttpError(422, "VALIDATION", "clientId is required");
    if (clientId !== req.appUser!.id || req.appUser!.role !== "client") {
      throw new HttpError(403, "FORBIDDEN", "Not authorized");
    }
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM purchases WHERE client_id = $1 ORDER BY created_at DESC`,
      [clientId],
    );
    res.json(rows.map(mapPurchase));
  } catch (e) {
    next(e);
  }
});

purchasesRouter.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT p.*, pf.photographer_id FROM purchases p
         JOIN portfolios pf ON pf.id = p.portfolio_id
        WHERE p.id = $1`,
      [req.params.id],
    );
    if (rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Purchase not found");
    const r = rows[0];
    const u = req.appUser!;
    const okClient = u.role === "client" && String(r.client_id) === u.id;
    const okPhoto = u.role === "photographer" && String(r.photographer_id) === u.id;
    if (!okClient && !okPhoto) throw new HttpError(403, "FORBIDDEN", "Not authorized");
    res.json(mapPurchase(r));
  } catch (e) {
    next(e);
  }
});
