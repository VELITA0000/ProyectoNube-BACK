import { Router } from "express";
import { PutObjectCommand, GetObjectCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { requireAuth, requireRole } from "../middleware/requireAuth.js";
import { HttpError } from "../http/errors.js";
import { getPool } from "../db/pool.js";
import { getS3 } from "../aws/clients.js";
import { getEnv } from "../config/env.js";
import { mapPhoto, mapPhotos } from "../domain/mappers.js";

export const photosRouter = Router();

type Pool = ReturnType<typeof getPool>;

async function loadPortfolio(pool: Pool, portfolioId: string) {
  const { rows } = await pool.query(
    `SELECT id, photographer_id, status FROM portfolios WHERE id = $1`,
    [portfolioId],
  );
  if (rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Portfolio not found");
  return rows[0] as { id: string; photographer_id: string; status: string };
}

async function assertClientCanReadPortfolio(pool: Pool, portfolioId: string, clientId: string) {
  const { rows } = await pool.query(
    `SELECT 1 FROM portfolio_clients WHERE portfolio_id = $1 AND client_id = $2`,
    [portfolioId, clientId],
  );
  if (rows.length === 0) throw new HttpError(403, "FORBIDDEN", "Not authorized");
}

// Presign an upload to originals/. The photo row starts in `uploaded` status
// and is INVISIBLE to the client until the photographer publishes the
// portfolio (which then enqueues the watermark Lambda).
photosRouter.post("/presign", requireAuth, requireRole("photographer"), async (req, res, next) => {
  try {
    const { portfolioId, fileName, contentType } = req.body ?? {};
    if (!portfolioId) throw new HttpError(422, "VALIDATION", "portfolioId is required");
    if (!fileName || !contentType) {
      throw new HttpError(422, "VALIDATION", "fileName and contentType are required");
    }
    const u = req.appUser!;
    const pool = getPool();
    const env = getEnv();
    const portfolio = await loadPortfolio(pool, portfolioId);
    if (String(portfolio.photographer_id) !== u.id) {
      throw new HttpError(403, "FORBIDDEN", "You are not the portfolio owner");
    }

    const photoId = randomUUID();
    const key = `originals/${portfolioId}/${photoId}-${fileName}`;

    await pool.query(
      `INSERT INTO photos (id, portfolio_id, original_key, status)
       VALUES ($1, $2, $3, 'uploaded')`,
      [photoId, portfolioId, key],
    );

    const s3 = getS3();
    const cmd = new PutObjectCommand({
      Bucket: env.S3_BUCKET_ORIGINALS,
      Key: key,
      ContentType: contentType,
    });
    const url = await getSignedUrl(s3, cmd, { expiresIn: 300 });
    res.json({ url, photoId, key });
  } catch (e) {
    next(e);
  }
});

// List photos in a portfolio.
//   - photographer (owner): sees all rows regardless of status. Originals are
//     served via /:id/original directly to them.
//   - client: only sees photos in 'ready' state, AND only if the portfolio is
//     published, AND only if they are linked via portfolio_clients.
photosRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const portfolioId = String(req.query.portfolioId ?? "");
    if (!portfolioId) throw new HttpError(422, "VALIDATION", "portfolioId is required");
    const pool = getPool();
    const u = req.appUser!;
    const portfolio = await loadPortfolio(pool, portfolioId);

    if (u.role === "photographer") {
      if (String(portfolio.photographer_id) !== u.id) {
        throw new HttpError(403, "FORBIDDEN", "Not authorized");
      }
      const { rows } = await pool.query(
        `SELECT * FROM photos WHERE portfolio_id = $1 ORDER BY uploaded_at`,
        [portfolioId],
      );
      return res.json(await mapPhotos(rows, false));
    }

    // client
    if (String(portfolio.status) !== "published") {
      throw new HttpError(403, "FORBIDDEN", "Portfolio not published");
    }
    await assertClientCanReadPortfolio(pool, portfolioId, u.id);
    const { rows } = await pool.query(
      `SELECT * FROM photos WHERE portfolio_id = $1 AND status = 'ready' ORDER BY uploaded_at`,
      [portfolioId],
    );
    // Set of photos this client already paid for in this portfolio. Each
    // matching photo gets its watermarked variant swapped for the original
    // in the gallery (other photos stay watermarked).
    const { rows: paidRows } = await pool.query(
      `SELECT DISTINCT unnest(photo_ids) AS photo_id
         FROM purchases
        WHERE client_id = $1 AND portfolio_id = $2 AND status = 'paid'`,
      [u.id, portfolioId],
    );
    const purchasedPhotoIds = new Set<string>(paidRows.map((r) => String(r.photo_id)));
    res.json(await mapPhotos(rows, true, purchasedPhotoIds));
  } catch (e) {
    next(e);
  }
});

// Single-photo lookup (used by the SPA after upload to refresh status).
photosRouter.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT p.*, pf.photographer_id, pf.status AS portfolio_status
         FROM photos p
         JOIN portfolios pf ON pf.id = p.portfolio_id
        WHERE p.id = $1`,
      [req.params.id],
    );
    if (rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Photo not found");
    const r = rows[0];
    const u = req.appUser!;
    let forClient = false;
    let purchasedPhotoIds: Set<string> | undefined;
    if (u.role === "photographer") {
      if (String(r.photographer_id) !== u.id) {
        throw new HttpError(403, "FORBIDDEN", "Not authorized");
      }
    } else {
      if (String(r.portfolio_status) !== "published" || r.status !== "ready") {
        throw new HttpError(403, "FORBIDDEN", "Not authorized");
      }
      await assertClientCanReadPortfolio(pool, String(r.portfolio_id), u.id);
      forClient = true;
      // Mirror the gallery behaviour for single-photo lookups (used by the
      // SPA after upload to refresh status).
      const { rows: paidRows } = await pool.query(
        `SELECT 1 FROM purchases
          WHERE client_id = $1 AND portfolio_id = $2 AND status = 'paid' AND $3 = ANY(photo_ids)
          LIMIT 1`,
        [u.id, String(r.portfolio_id), String(r.id)],
      );
      purchasedPhotoIds = paidRows.length > 0 ? new Set([String(r.id)]) : new Set();
    }
    res.json(await mapPhoto(r, forClient, purchasedPhotoIds));
  } catch (e) {
    next(e);
  }
});

// Presigned GET on the ORIGINAL file.
//   - photographer (owner): always allowed (gallery preview, downloads).
//   - client: only if they purchased this photo in this portfolio.
photosRouter.get("/:id/original", requireAuth, async (req, res, next) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT p.*, pf.photographer_id
         FROM photos p
         JOIN portfolios pf ON pf.id = p.portfolio_id
        WHERE p.id = $1`,
      [req.params.id],
    );
    if (rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Photo not found");
    const r = rows[0];
    const u = req.appUser!;
    const env = getEnv();
    const s3 = getS3();

    if (u.role === "photographer" && String(r.photographer_id) === u.id) {
      const cmd = new GetObjectCommand({ Bucket: env.S3_BUCKET_ORIGINALS, Key: r.original_key });
      const url = await getSignedUrl(s3, cmd, { expiresIn: 300 });
      return res.json({ url, expiresIn: 300 });
    }
    if (u.role === "client") {
      const purchase = await pool.query(
        `SELECT 1 FROM purchases
          WHERE client_id = $1 AND portfolio_id = $2 AND status = 'paid' AND $3 = ANY(photo_ids)
          LIMIT 1`,
        [u.id, r.portfolio_id, req.params.id],
      );
      if (purchase.rows.length === 0) {
        throw new HttpError(403, "NOT_PURCHASED", "You must purchase the photo to download the original");
      }
      const cmd = new GetObjectCommand({ Bucket: env.S3_BUCKET_ORIGINALS, Key: r.original_key });
      const url = await getSignedUrl(s3, cmd, { expiresIn: 300 });
      return res.json({ url, expiresIn: 300 });
    }
    throw new HttpError(403, "FORBIDDEN", "Not authorized");
  } catch (e) {
    next(e);
  }
});

photosRouter.delete("/:id", requireAuth, requireRole("photographer"), async (req, res, next) => {
  try {
    const pool = getPool();
    const env = getEnv();
    const { rows } = await pool.query(
      `SELECT p.*, pf.photographer_id
         FROM photos p
         JOIN portfolios pf ON pf.id = p.portfolio_id
        WHERE p.id = $1`,
      [req.params.id],
    );
    if (rows.length === 0) throw new HttpError(404, "NOT_FOUND", "Photo not found");
    const r = rows[0];
    if (String(r.photographer_id) !== req.appUser!.id) {
      throw new HttpError(403, "FORBIDDEN", "You are not the owner");
    }

    const base = String(r.original_key).replace(/^originals\//, "");
    const keys = [
      String(r.original_key),
      `watermarked/${base}`,
      `thumbnails/${base}`,
    ].filter(Boolean);

    const s3 = getS3();
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: env.S3_BUCKET_ORIGINALS,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      }),
    );
    await pool.query(`DELETE FROM photos WHERE id = $1`, [req.params.id]);
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});
