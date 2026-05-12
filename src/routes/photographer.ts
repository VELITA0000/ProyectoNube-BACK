import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";
import { HttpError } from "../http/errors.js";
import { getPool } from "../db/pool.js";
import { mapPurchase, mapUser } from "../domain/mappers.js";

export const photographerRouter = Router();

// All clients the photographer has explicitly added (via the Clients page) or
// implicitly added (by associating them with one of their portfolios).
photographerRouter.get("/clients", requireAuth, requireRole("photographer"), async (req, res, next) => {
  try {
    const photographerId = String(req.query.photographerId ?? "");
    if (!photographerId) throw new HttpError(422, "VALIDATION", "photographerId is required");
    if (photographerId !== req.appUser!.id) {
      throw new HttpError(403, "FORBIDDEN", "Not authorized");
    }
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT u.*
         FROM users u
         JOIN photographer_clients pc ON pc.client_id = u.id
        WHERE pc.photographer_id = $1
        ORDER BY u.name`,
      [photographerId],
    );
    res.json(rows.map(mapUser));
  } catch (e) {
    next(e);
  }
});

// Add a client by email. They must already have signed up as a `client`.
photographerRouter.post("/clients", requireAuth, requireRole("photographer"), async (req, res, next) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!email) throw new HttpError(422, "VALIDATION", "email is required");
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM users WHERE email = $1 AND role = 'client'`,
      [email],
    );
    if (rows.length === 0) {
      throw new HttpError(
        404,
        "CLIENT_NOT_REGISTERED",
        "No client account with that email. Ask the client to sign up first.",
      );
    }
    const client = rows[0];
    await pool.query(
      `INSERT INTO photographer_clients (photographer_id, client_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.appUser!.id, String(client.id)],
    );
    res.status(201).json(mapUser(client));
  } catch (e) {
    next(e);
  }
});

// Remove a client from the photographer's roster. The client account itself
// remains; only the link is dropped. Existing portfolios still associated with
// them are not changed (use DELETE /portfolios/:id/clients/:clientId for that).
photographerRouter.delete(
  "/clients/:clientId",
  requireAuth,
  requireRole("photographer"),
  async (req, res, next) => {
    try {
      const pool = getPool();
      await pool.query(
        `DELETE FROM photographer_clients WHERE photographer_id = $1 AND client_id = $2`,
        [req.appUser!.id, req.params.clientId],
      );
      res.status(204).send();
    } catch (e) {
      next(e);
    }
  },
);

photographerRouter.get("/purchases", requireAuth, requireRole("photographer"), async (req, res, next) => {
  try {
    const photographerId = String(req.query.photographerId ?? "");
    if (!photographerId) throw new HttpError(422, "VALIDATION", "photographerId is required");
    if (photographerId !== req.appUser!.id) {
      throw new HttpError(403, "FORBIDDEN", "Not authorized");
    }
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT p.*
         FROM purchases p
         JOIN portfolios pf ON pf.id = p.portfolio_id
        WHERE pf.photographer_id = $1
        ORDER BY p.created_at DESC`,
      [photographerId],
    );
    res.json(rows.map(mapPurchase));
  } catch (e) {
    next(e);
  }
});
