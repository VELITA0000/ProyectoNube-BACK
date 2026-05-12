import { Router } from "express";
import Stripe from "stripe";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";
import { HttpError } from "../http/errors.js";
import { getPool } from "../db/pool.js";
import { getEnv } from "../config/env.js";

export const cartRouter = Router();

function mapCartRow(r: Record<string, unknown>) {
  return {
    photoId: String(r.photo_id),
    portfolioId: String(r.portfolio_id),
    unitPrice: Number(r.unit_price),
  };
}

function getAuthorizedClientId(req: { query: Record<string, unknown>; appUser?: { id: string } }) {
  const clientId = String(req.query.clientId ?? "");
  if (!clientId) throw new HttpError(422, "VALIDATION", "clientId is required");
  if (!req.appUser || clientId !== req.appUser.id) throw new HttpError(403, "FORBIDDEN", "Not authorized");
  return clientId;
}

async function listCart(clientId: string) {
  const { rows } = await getPool().query(
    `SELECT photo_id, portfolio_id, unit_price
       FROM cart_items WHERE client_id = $1 ORDER BY added_at`,
    [clientId],
  );
  return rows.map(mapCartRow);
}

cartRouter.get("/", requireAuth, requireRole("client"), async (req, res, next) => {
  try {
    const clientId = getAuthorizedClientId(req);
    res.json(await listCart(clientId));
  } catch (e) {
    next(e);
  }
});

cartRouter.post("/items", requireAuth, requireRole("client"), async (req, res, next) => {
  try {
    const { photoId, portfolioId, unitPrice } = req.body ?? {};
    if (!photoId || !portfolioId) {
      throw new HttpError(422, "VALIDATION", "photoId and portfolioId are required");
    }
    const uid = req.appUser!.id;
    const env = getEnv();
    const price = unitPrice ?? env.DEFAULT_PHOTO_UNIT_PRICE_USD;
    const pool = getPool();

    // Authorization: the photo must belong to a published portfolio the
    // client has been linked to.
    const { rows: pf } = await pool.query(
      `SELECT pf.id, pf.status, pc.client_id
         FROM portfolios pf
         LEFT JOIN portfolio_clients pc
           ON pc.portfolio_id = pf.id AND pc.client_id = $2
        WHERE pf.id = $1`,
      [portfolioId, uid],
    );
    if (pf.length === 0) throw new HttpError(404, "NOT_FOUND", "Portfolio not found");
    if (String(pf[0].status) !== "published" || !pf[0].client_id) {
      throw new HttpError(403, "FORBIDDEN", "You are not allowed to buy from this portfolio");
    }

    const { rows: photo } = await pool.query(
      `SELECT id FROM photos WHERE id = $1 AND portfolio_id = $2 AND status = 'ready'`,
      [photoId, portfolioId],
    );
    if (photo.length === 0) {
      throw new HttpError(404, "NOT_FOUND", "Photo not found in this portfolio (or not ready)");
    }

    const alreadyPaid = await pool.query(
      `SELECT 1 FROM purchases
        WHERE client_id = $1 AND portfolio_id = $2 AND status = 'paid' AND $3 = ANY(photo_ids)
        LIMIT 1`,
      [uid, portfolioId, photoId],
    );
    if (alreadyPaid.rows.length > 0) {
      throw new HttpError(
        409,
        "ALREADY_PURCHASED",
        "This photo was already purchased and cannot be added to the cart again",
      );
    }
    await pool.query(
      `INSERT INTO cart_items (client_id, photo_id, portfolio_id, unit_price)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (client_id, photo_id) DO UPDATE SET unit_price = EXCLUDED.unit_price`,
      [uid, photoId, portfolioId, price],
    );
    res.json(await listCart(uid));
  } catch (e) {
    next(e);
  }
});

cartRouter.delete("/items/:photoId", requireAuth, requireRole("client"), async (req, res, next) => {
  try {
    const clientId = getAuthorizedClientId(req);
    const pool = getPool();
    await pool.query(`DELETE FROM cart_items WHERE client_id = $1 AND photo_id = $2`, [
      clientId,
      req.params.photoId,
    ]);
    res.json(await listCart(clientId));
  } catch (e) {
    next(e);
  }
});

cartRouter.delete("/", requireAuth, requireRole("client"), async (req, res, next) => {
  try {
    const clientId = getAuthorizedClientId(req);
    await getPool().query(`DELETE FROM cart_items WHERE client_id = $1`, [clientId]);
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

// Client-driven confirmation. Called by the SPA right after
// `stripe.confirmPayment` resolves successfully. Without this endpoint, the
// purchase rows would stay in `pending` until the Stripe webhook fires —
// which only works if the operator wired the webhook URL on stripe.com AND
// pasted the signing secret as STRIPE_WEBHOOK_SECRET. This path makes the
// happy flow work even with no webhook configured.
//
// The webhook handler keeps doing the same UPDATE in production, so the two
// paths are idempotent: whichever one wins flips the row, the other becomes
// a no-op (already `paid`).
cartRouter.post("/checkout/confirm", requireAuth, requireRole("client"), async (req, res, next) => {
  try {
    const { paymentIntentId } = req.body ?? {};
    if (!paymentIntentId || typeof paymentIntentId !== "string") {
      throw new HttpError(422, "VALIDATION", "paymentIntentId is required");
    }
    const env = getEnv();
    if (!env.STRIPE_SECRET_KEY.trim()) {
      throw new HttpError(503, "STRIPE_NOT_CONFIGURED", "Stripe not configured (STRIPE_SECRET_KEY)");
    }
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

    // Authorization: only the user who started this checkout can confirm it.
    // We stamped clientId in PaymentIntent.metadata at creation time.
    const piClientId = pi.metadata?.clientId ?? "";
    if (!piClientId || piClientId !== req.appUser!.id) {
      throw new HttpError(403, "FORBIDDEN", "Not your payment");
    }

    const pool = getPool();
    if (pi.status === "succeeded") {
      await pool.query(
        `UPDATE purchases SET status = 'paid'
          WHERE stripe_payment_intent_id = $1 AND client_id = $2 AND status = 'pending'`,
        [pi.id, req.appUser!.id],
      );
      await pool.query(`DELETE FROM cart_items WHERE client_id = $1`, [req.appUser!.id]);
    } else if (
      pi.status === "canceled" ||
      pi.status === "requires_payment_method"
    ) {
      // Card declined / dropped flow → mark pending purchases as failed so the
      // /client/purchases page surfaces the right state instead of hanging on
      // "pending" forever.
      await pool.query(
        `UPDATE purchases SET status = 'failed'
          WHERE stripe_payment_intent_id = $1 AND client_id = $2 AND status = 'pending'`,
        [pi.id, req.appUser!.id],
      );
    }
    // Other intermediate statuses (requires_action, processing, …) → leave
    // the row pending; the SPA will re-poll or the webhook will catch it.

    res.json({ status: pi.status });
  } catch (e) {
    next(e);
  }
});

cartRouter.post("/checkout", requireAuth, requireRole("client"), async (req, res, next) => {
  try {
    const { clientId } = req.body ?? {};
    if (!clientId) throw new HttpError(422, "VALIDATION", "clientId is required");
    if (clientId !== req.appUser!.id) throw new HttpError(403, "FORBIDDEN", "Not authorized");
    const env = getEnv();
    if (!env.STRIPE_SECRET_KEY.trim()) {
      throw new HttpError(503, "STRIPE_NOT_CONFIGURED", "Stripe not configured (STRIPE_SECRET_KEY)");
    }
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    const pool = getPool();

    const { rows: items } = await pool.query(
      `SELECT photo_id, portfolio_id, unit_price FROM cart_items WHERE client_id = $1`,
      [clientId],
    );
    if (items.length === 0) throw new HttpError(422, "EMPTY_CART", "Cart is empty");

    // Group by portfolio so each `purchases` row stays atomic to a single
    // portfolio (mirrors what the watermark / publish flow already assumes).
    const byPortfolio = new Map<string, typeof items>();
    for (const it of items) {
      const pid = String(it.portfolio_id);
      const arr = byPortfolio.get(pid) ?? [];
      arr.push(it);
      byPortfolio.set(pid, arr);
    }

    const pendingPurchases: unknown[] = [];
    let totalUsd = 0;
    for (const [portfolioId, arr] of byPortfolio) {
      const total = arr.reduce((s, r) => s + Number(r.unit_price), 0);
      totalUsd += total;
      const photoIds = arr.map((r) => String(r.photo_id));
      const { rows: pur } = await pool.query(
        `INSERT INTO purchases (client_id, portfolio_id, photo_ids, total, status)
         VALUES ($1, $2, $3, $4, 'pending')
         RETURNING *`,
        [clientId, portfolioId, photoIds, total],
      );
      pendingPurchases.push({
        id: String(pur[0].id),
        clientId,
        portfolioId,
        photoIds,
        total: Number(pur[0].total),
        status: "pending",
        createdAt: new Date(pur[0].created_at).toISOString(),
      });
    }

    const ids = (pendingPurchases as { id: string }[]).map((p) => p.id);
    const amountCents = Math.round(totalUsd * 100);
    const pi = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      metadata: {
        clientId,
        purchaseIds: ids.join(","),
      },
    });
    await pool.query(
      `UPDATE purchases SET stripe_payment_intent_id = $1 WHERE id = ANY($2::uuid[])`,
      [pi.id, ids],
    );

    res.json({
      paymentIntentId: pi.id,
      clientSecret: pi.client_secret,
      amount: amountCents,
      currency: "usd" as const,
      pendingPurchases,
    });
  } catch (e) {
    next(e);
  }
});
