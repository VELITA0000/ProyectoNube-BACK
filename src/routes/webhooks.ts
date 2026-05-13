import type { Request, Response, NextFunction } from "express";
import Stripe from "stripe";
import { getEnv } from "../config/env.js";
import { getPool } from "../db/pool.js";
import { publishTransactionNotification } from "../notifications/sns.js";
import { emitEmfCount } from "../observability/emf.js";

async function loadPurchaseSummary(clientId: string, purchaseIds: string[]) {
  if (!clientId || purchaseIds.length === 0) {
    return { clientEmail: undefined, clientName: undefined, totalUsd: undefined };
  }
  const pool = getPool();
  const clientQ = await pool.query(`SELECT email, name FROM users WHERE id = $1`, [clientId]);
  const purchasesQ = await pool.query(
    `SELECT total FROM purchases WHERE id = ANY($1::uuid[]) AND client_id = $2`,
    [purchaseIds, clientId],
  );
  const totalUsd = purchasesQ.rows.reduce((acc, row) => acc + Number(row.total), 0);
  return {
    clientEmail: clientQ.rows[0]?.email ? String(clientQ.rows[0].email) : undefined,
    clientName: clientQ.rows[0]?.name ? String(clientQ.rows[0].name) : undefined,
    totalUsd: purchasesQ.rows.length > 0 ? totalUsd : undefined,
  };
}

export async function stripeWebhookHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const env = getEnv();
    if (!env.STRIPE_SECRET_KEY.trim() || !env.STRIPE_WEBHOOK_SECRET.trim()) {
      return res.status(503).send("Stripe not configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET)");
    }
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    const sig = req.headers["stripe-signature"];
    try {
      emitEmfCount({ StripeWebhookIngressCount: 1 }, { Service: "api", Endpoint: "stripe-webhook" });
    } catch {
      /* métrica best-effort */
    }
    if (!sig || !Buffer.isBuffer(req.body)) {
      return res.status(400).send("Missing signature or body");
    }
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Stripe webhook signature", err);
      return res.status(400).send("Invalid signature");
    }

    const pool = getPool();

    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object as Stripe.PaymentIntent;
      const clientId = pi.metadata?.clientId;
      const purchaseIds = pi.metadata?.purchaseIds?.split(",").filter(Boolean) ?? [];
      let resolvedPurchaseIds = purchaseIds;

      if (clientId && purchaseIds.length > 0) {
        await pool.query(
          `UPDATE purchases SET status = 'paid' WHERE id = ANY($1::uuid[]) AND client_id = $2`,
          [purchaseIds, clientId],
        );
        await pool.query(`DELETE FROM cart_items WHERE client_id = $1`, [clientId]);
      } else {
        await pool.query(
          `UPDATE purchases SET status = 'paid' WHERE stripe_payment_intent_id = $1`,
          [pi.id],
        );
        if (pi.metadata?.clientId) {
          await pool.query(`DELETE FROM cart_items WHERE client_id = $1`, [pi.metadata.clientId]);
          const resolved = await pool.query(
            `SELECT id FROM purchases WHERE stripe_payment_intent_id = $1`,
            [pi.id],
          );
          resolvedPurchaseIds = resolved.rows.map((r) => String(r.id));
        }
      }

      const effectiveClientId = clientId || pi.metadata?.clientId;
      const summary = effectiveClientId
        ? await loadPurchaseSummary(effectiveClientId, resolvedPurchaseIds)
        : { clientEmail: undefined, clientName: undefined, totalUsd: undefined };

      await publishTransactionNotification({
        event: "purchase.succeeded",
        clientId: effectiveClientId,
        clientEmail: summary.clientEmail,
        clientName: summary.clientName,
        purchaseIds: resolvedPurchaseIds,
        totalUsd: summary.totalUsd ?? (typeof pi.amount === "number" ? pi.amount / 100 : undefined),
        paymentIntentId: pi.id,
      });
    }

    if (event.type === "payment_intent.payment_failed") {
      const pi = event.data.object as Stripe.PaymentIntent;
      await pool.query(
        `UPDATE purchases SET status = 'failed' WHERE stripe_payment_intent_id = $1`,
        [pi.id],
      );

      await publishTransactionNotification({
        event: "purchase.failed",
        clientId: pi.metadata?.clientId,
        paymentIntentId: pi.id,
        totalUsd: typeof pi.amount === "number" ? pi.amount / 100 : undefined,
        message: pi.last_payment_error?.message,
      });
    }

    res.json({ received: true });
  } catch (e) {
    next(e);
  }
}
