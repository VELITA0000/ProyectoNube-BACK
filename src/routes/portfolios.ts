import { Router } from "express";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";
import { HttpError } from "../http/errors.js";
import { getPool } from "../db/pool.js";
import { getSqs } from "../aws/clients.js";
import { getEnv } from "../config/env.js";
import { mapPortfolio, type PortfolioClientSummary } from "../domain/mappers.js";
import { publishTransactionNotification } from "../notifications/sns.js";

export const portfoliosRouter = Router();

type Pool = ReturnType<typeof getPool>;

async function loadPortfolioClients(
  pool: Pool,
  portfolioIds: string[],
): Promise<Map<string, PortfolioClientSummary[]>> {
  const map = new Map<string, PortfolioClientSummary[]>();
  if (portfolioIds.length === 0) return map;
  const { rows } = await pool.query(
    `SELECT pc.portfolio_id, u.id, u.name, u.email
       FROM portfolio_clients pc
       JOIN users u ON u.id = pc.client_id
      WHERE pc.portfolio_id = ANY($1::uuid[])
      ORDER BY u.name`,
    [portfolioIds],
  );
  for (const r of rows) {
    const pid = String(r.portfolio_id);
    const arr = map.get(pid) ?? [];
    arr.push({ id: String(r.id), name: String(r.name), email: String(r.email) });
    map.set(pid, arr);
  }
  return map;
}

async function assertOwner(pool: Pool, portfolioId: string, photographerId: string) {
  const { rows } = await pool.query(
    `SELECT photographer_id, status FROM portfolios WHERE id = $1`,
    [portfolioId],
  );
  if (rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Portfolio not found");
  if (String(rows[0].photographer_id) !== photographerId) {
    throw new HttpError(403, "FORBIDDEN", "You are not the owner");
  }
  return rows[0] as { photographer_id: string; status: string };
}

// Resolve a list of {clientIds[], clientEmails[]} into existing client UUIDs.
// Both are optional. Emails that don't match any registered client are returned
// as `unknownEmails` so the caller can surface them in the response.
async function resolveClientIds(
  pool: Pool,
  raw: { clientIds?: unknown; clientEmails?: unknown },
): Promise<{ ids: string[]; unknownEmails: string[] }> {
  const ids = Array.isArray(raw.clientIds)
    ? Array.from(new Set(raw.clientIds.map((x) => String(x).trim()).filter(Boolean)))
    : [];
  const emails = Array.isArray(raw.clientEmails)
    ? Array.from(
        new Set(raw.clientEmails.map((x) => String(x).trim().toLowerCase()).filter(Boolean)),
      )
    : [];

  const resolved = new Set<string>();
  const unknownEmails: string[] = [];

  if (ids.length > 0) {
    const { rows } = await pool.query(
      `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND role = 'client'`,
      [ids],
    );
    for (const r of rows) resolved.add(String(r.id));
  }

  if (emails.length > 0) {
    const { rows } = await pool.query(
      `SELECT id, email FROM users WHERE email = ANY($1::text[]) AND role = 'client'`,
      [emails],
    );
    const seen = new Set<string>();
    for (const r of rows) {
      resolved.add(String(r.id));
      seen.add(String(r.email));
    }
    for (const e of emails) {
      if (!seen.has(e)) unknownEmails.push(e);
    }
  }

  return { ids: Array.from(resolved), unknownEmails };
}

async function ensurePhotographerClientLinks(
  pool: Pool,
  photographerId: string,
  clientIds: string[],
) {
  if (clientIds.length === 0) return;
  // Bulk INSERT … ON CONFLICT DO NOTHING keeps the photographer's client list
  // in sync whenever a portfolio is associated with a client. This way the
  // /studio/clients page reflects everyone the photographer has ever shared
  // a portfolio with, without a separate manual add step.
  await pool.query(
    `INSERT INTO photographer_clients (photographer_id, client_id)
     SELECT $1::uuid, c::uuid FROM unnest($2::uuid[]) AS c
     ON CONFLICT DO NOTHING`,
    [photographerId, clientIds],
  );
}

// ----- list / get -----

portfoliosRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const photographerId = String(req.query.photographerId ?? "");
    if (!photographerId) {
      throw new HttpError(422, "VALIDATION", "photographerId is required");
    }
    const u = req.appUser!;
    if (u.role === "photographer" && u.id !== photographerId) {
      throw new HttpError(403, "FORBIDDEN", "Cannot list another photographer's portfolios");
    }
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM portfolios WHERE photographer_id = $1 ORDER BY created_at DESC`,
      [photographerId],
    );
    const ids = rows.map((r) => String(r.id));
    const clientsByPortfolio = await loadPortfolioClients(pool, ids);
    res.json(rows.map((r) => mapPortfolio(r, clientsByPortfolio.get(String(r.id)) ?? [])));
  } catch (e) {
    next(e);
  }
});

// Portfolios shared with the authenticated client (only those that have been
// published by the photographer). This is what powers `/client` (My portfolios).
portfoliosRouter.get("/shared-with-me", requireAuth, requireRole("client"), async (req, res, next) => {
  try {
    const u = req.appUser!;
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT p.*,
              u.name  AS photographer_name,
              u.email AS photographer_email,
              u.phone AS photographer_phone,
              u.avatar_url AS photographer_avatar_url
         FROM portfolios p
         JOIN portfolio_clients pc ON pc.portfolio_id = p.id
         JOIN users u ON u.id = p.photographer_id
        WHERE pc.client_id = $1 AND p.status = 'published'
        ORDER BY p.published_at DESC NULLS LAST, p.created_at DESC`,
      [u.id],
    );
    res.json(
      rows.map((r) => ({
        ...mapPortfolio(r),
        photographerName: r.photographer_name ? String(r.photographer_name) : undefined,
        photographerEmail: r.photographer_email ? String(r.photographer_email) : undefined,
        photographerPhone: r.photographer_phone ? String(r.photographer_phone) : undefined,
        photographerAvatarUrl: r.photographer_avatar_url
          ? String(r.photographer_avatar_url)
          : undefined,
      })),
    );
  } catch (e) {
    next(e);
  }
});

portfoliosRouter.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const pool = getPool();
    const portfolioId = String(req.params.id);
    const { rows } = await pool.query(`SELECT * FROM portfolios WHERE id = $1`, [portfolioId]);
    if (rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Portfolio not found");
    const p = rows[0];
    const u = req.appUser!;

    if (u.role === "photographer") {
      if (String(p.photographer_id) !== u.id) {
        throw new HttpError(403, "FORBIDDEN", "Not authorized");
      }
    } else {
      // Clients only see published portfolios they're associated with.
      if (String(p.status) !== "published") throw new HttpError(403, "FORBIDDEN", "Not authorized");
      const link = await pool.query(
        `SELECT 1 FROM portfolio_clients WHERE portfolio_id = $1 AND client_id = $2`,
        [portfolioId, u.id],
      );
      if (link.rows.length === 0) throw new HttpError(403, "FORBIDDEN", "Not authorized");
    }

    const clientsByPortfolio = await loadPortfolioClients(pool, [String(p.id)]);
    const portfolio = mapPortfolio(p, clientsByPortfolio.get(String(p.id)) ?? []);

    if (u.role === "client") {
      const ph = await pool.query(
        `SELECT name, email, phone, avatar_url FROM users WHERE id = $1`,
        [p.photographer_id],
      );
      const pr = ph.rows[0];
      res.json({
        ...portfolio,
        photographerName: pr?.name ? String(pr.name) : undefined,
        photographerEmail: pr?.email ? String(pr.email) : undefined,
        photographerPhone: pr?.phone ? String(pr.phone) : undefined,
        photographerAvatarUrl: pr?.avatar_url ? String(pr.avatar_url) : undefined,
      });
    } else {
      res.json(portfolio);
    }
  } catch (e) {
    next(e);
  }
});

// ----- create / update / delete -----

portfoliosRouter.post("/", requireAuth, requireRole("photographer"), async (req, res, next) => {
  try {
    const { title, description, clientIds, clientEmails } = req.body ?? {};
    if (!title) throw new HttpError(422, "VALIDATION", "title is required");
    const u = req.appUser!;
    const pool = getPool();

    const { ids: linkClientIds, unknownEmails } = await resolveClientIds(pool, {
      clientIds,
      clientEmails,
    });

    const { rows } = await pool.query(
      `INSERT INTO portfolios (photographer_id, title, description)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [u.id, title, description ?? null],
    );
    const portfolioId = String(rows[0].id);

    if (linkClientIds.length > 0) {
      await pool.query(
        `INSERT INTO portfolio_clients (portfolio_id, client_id)
         SELECT $1::uuid, c::uuid FROM unnest($2::uuid[]) AS c
         ON CONFLICT DO NOTHING`,
        [portfolioId, linkClientIds],
      );
      await ensurePhotographerClientLinks(pool, u.id, linkClientIds);
    }

    const clientsByPortfolio = await loadPortfolioClients(pool, [portfolioId]);
    res.status(201).json({
      ...mapPortfolio(rows[0], clientsByPortfolio.get(portfolioId) ?? []),
      unknownEmails,
    });
  } catch (e) {
    next(e);
  }
});

portfoliosRouter.patch("/:id", requireAuth, requireRole("photographer"), async (req, res, next) => {
  try {
    const pool = getPool();
    const portfolioId = String(req.params.id);
    await assertOwner(pool, portfolioId, req.appUser!.id);
    const { title, description, coverPhotoId } = req.body ?? {};
    let coverUrl: string | null = null;
    if (coverPhotoId) {
      const ph = await pool.query(
        `SELECT watermarked_url FROM photos WHERE id = $1 AND portfolio_id = $2`,
        [coverPhotoId, portfolioId],
      );
      if (ph.rows[0]?.watermarked_url) coverUrl = String(ph.rows[0].watermarked_url);
    }
    const { rows } = await pool.query(
      `UPDATE portfolios SET
         title = COALESCE($2, title),
         description = COALESCE($3, description),
         cover_url = COALESCE($4, cover_url),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [portfolioId, title ?? null, description ?? null, coverUrl],
    );
    const clientsByPortfolio = await loadPortfolioClients(pool, [portfolioId]);
    res.json(mapPortfolio(rows[0], clientsByPortfolio.get(portfolioId) ?? []));
  } catch (e) {
    next(e);
  }
});

portfoliosRouter.delete("/:id", requireAuth, requireRole("photographer"), async (req, res, next) => {
  try {
    const pool = getPool();
    const portfolioId = String(req.params.id);
    await assertOwner(pool, portfolioId, req.appUser!.id);
    await pool.query(`DELETE FROM portfolios WHERE id = $1`, [portfolioId]);
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

// ----- client associations -----

portfoliosRouter.post("/:id/clients", requireAuth, requireRole("photographer"), async (req, res, next) => {
  try {
    const pool = getPool();
    const portfolioId = String(req.params.id);
    await assertOwner(pool, portfolioId, req.appUser!.id);
    const { clientIds, clientEmails } = req.body ?? {};
    const { ids: linkClientIds, unknownEmails } = await resolveClientIds(pool, {
      clientIds,
      clientEmails,
    });
    if (linkClientIds.length > 0) {
      await pool.query(
        `INSERT INTO portfolio_clients (portfolio_id, client_id)
         SELECT $1::uuid, c::uuid FROM unnest($2::uuid[]) AS c
         ON CONFLICT DO NOTHING`,
        [portfolioId, linkClientIds],
      );
      await ensurePhotographerClientLinks(pool, req.appUser!.id, linkClientIds);
    }
    const clientsByPortfolio = await loadPortfolioClients(pool, [portfolioId]);
    res.json({
      clients: clientsByPortfolio.get(portfolioId) ?? [],
      unknownEmails,
    });
  } catch (e) {
    next(e);
  }
});

portfoliosRouter.delete(
  "/:id/clients/:clientId",
  requireAuth,
  requireRole("photographer"),
  async (req, res, next) => {
    try {
      const pool = getPool();
      const portfolioId = String(req.params.id);
      const clientId = String(req.params.clientId);
      await assertOwner(pool, portfolioId, req.appUser!.id);
      await pool.query(
        `DELETE FROM portfolio_clients WHERE portfolio_id = $1 AND client_id = $2`,
        [portfolioId, clientId],
      );
      const clientsByPortfolio = await loadPortfolioClients(pool, [portfolioId]);
      res.json({ clients: clientsByPortfolio.get(portfolioId) ?? [] });
    } catch (e) {
      next(e);
    }
  },
);

// ----- publish -----

portfoliosRouter.post("/:id/publish", requireAuth, requireRole("photographer"), async (req, res, next) => {
  try {
    const pool = getPool();
    const portfolioId = String(req.params.id);
    await assertOwner(pool, portfolioId, req.appUser!.id);
    const env = getEnv();
    const sqs = getSqs();

    // Pick up every photo that has not been watermarked yet (`uploaded`) and
    // also those previously stuck in `processing` (e.g. SQS message lost
    // before reaching the Lambda) so a re-publish recovers them.
    const { rows: pending } = await pool.query(
      `SELECT id, original_key FROM photos
        WHERE portfolio_id = $1 AND status IN ('uploaded','processing','failed')`,
      [portfolioId],
    );

    for (const p of pending) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: env.SQS_WATERMARK_QUEUE_URL,
          MessageBody: JSON.stringify({
            bucket: env.S3_BUCKET_ORIGINALS,
            key: String(p.original_key),
            photoId: String(p.id),
          }),
        }),
      );
    }
    if (pending.length > 0) {
      await pool.query(
        `UPDATE photos SET status = 'processing'
          WHERE portfolio_id = $1 AND status IN ('uploaded','failed')`,
        [portfolioId],
      );
    }

    const { rows: updated } = await pool.query(
      `UPDATE portfolios
          SET status = 'published',
              published_at = COALESCE(published_at, now()),
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [portfolioId],
    );

    const clientsByPortfolio = await loadPortfolioClients(pool, [portfolioId]);
    const recipients = clientsByPortfolio.get(portfolioId) ?? [];
    let notificationsSent = 0;
    for (const c of recipients) {
      const ok = await publishTransactionNotification({
        event: "session.published",
        clientId: c.id,
        clientEmail: c.email,
        clientName: c.name,
        sessionId: portfolioId,
        sessionTitle: String(updated[0].title),
        sessionUrl: `${env.FRONTEND_ORIGIN}/client/portfolios/${req.params.id}`,
      });
      if (ok) notificationsSent++;
    }

    res.json({
      portfolio: mapPortfolio(updated[0], recipients),
      enqueuedPhotos: pending.length,
      notificationsSent,
    });
  } catch (e) {
    next(e);
  }
});
