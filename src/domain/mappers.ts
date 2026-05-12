import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AppUser } from "../middleware/requireAuth.js";
import { getS3 } from "../aws/clients.js";
import { getEnv } from "../config/env.js";

export function mapUser(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    email: String(r.email),
    name: String(r.name),
    role: r.role as "photographer" | "client",
    avatarUrl: r.avatar_url ? String(r.avatar_url) : undefined,
    phone: r.phone ? String(r.phone) : undefined,
    studioName: r.studio_name ? String(r.studio_name) : undefined,
    bio: r.bio ? String(r.bio) : undefined,
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

export type PortfolioClientSummary = { id: string; name: string; email: string };

export function mapPortfolio(
  r: Record<string, unknown>,
  clients: PortfolioClientSummary[] = [],
) {
  return {
    id: String(r.id),
    photographerId: String(r.photographer_id),
    title: String(r.title),
    description: r.description ? String(r.description) : undefined,
    coverUrl: r.cover_url ? String(r.cover_url) : undefined,
    status: (r.status ?? "draft") as "draft" | "published",
    publishedAt: r.published_at ? new Date(r.published_at as string).toISOString() : undefined,
    clients,
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

const PRESIGN_TTL_SECONDS = 60 * 30;

// `watermarked_url` / `thumbnail_url` in DB hold S3 keys (written by the
// watermark Lambda). The API turns them into presigned GET URLs on the fly so
// the buckets stay private. Legacy rows that already store full URLs (https://…)
// are passed through untouched.
async function resolveObjectUrl(value: unknown): Promise<string> {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  const env = getEnv();
  const cmd = new GetObjectCommand({ Bucket: env.S3_BUCKET_ORIGINALS, Key: raw });
  return getSignedUrl(getS3(), cmd, { expiresIn: PRESIGN_TTL_SECONDS });
}

// Sign a presigned GET on the original S3 key. Used to render the photographer
// gallery — they should always see the unmodified upload (full quality, no
// watermark) regardless of the photo's lifecycle state.
async function signOriginalUrl(originalKey: unknown): Promise<string> {
  const raw = typeof originalKey === "string" ? originalKey.trim() : "";
  if (!raw) return "";
  const env = getEnv();
  const cmd = new GetObjectCommand({ Bucket: env.S3_BUCKET_ORIGINALS, Key: raw });
  return getSignedUrl(getS3(), cmd, { expiresIn: PRESIGN_TTL_SECONDS });
}

export type PhotoStatus = "uploaded" | "processing" | "ready" | "failed";

export type MappedPhoto = {
  id: string;
  portfolioId: string;
  originalKey: string;
  watermarkedUrl: string;
  thumbnailUrl: string;
  uploadedAt: string;
  status: PhotoStatus;
  /**
   * True when this photo belongs to a `paid` purchase by the requesting
   * client. Only meaningful in client responses (always `false` from the
   * photographer view, where the concept doesn't apply). The SPA uses it
   * to swap the "Select / In cart" toggle for a "Download" button.
   */
  purchased: boolean;
};

export async function mapPhoto(
  r: Record<string, unknown>,
  forClient: boolean,
  purchasedPhotoIds?: Set<string>,
): Promise<MappedPhoto> {
  let watermarkedUrl: string;
  let thumbnailUrl: string;
  let purchased = false;

  if (forClient) {
    // Once the client has paid for THIS specific photo, drop the watermarked
    // variant from their gallery and serve the clean original instead. Other
    // photos in the same portfolio stay watermarked. The /photos/:id/original
    // endpoint still exists for explicit downloads — this swap just keeps the
    // gallery in sync visually without needing a separate "purchased" badge.
    purchased = purchasedPhotoIds?.has(String(r.id)) ?? false;
    if (purchased) {
      const original = await signOriginalUrl(r.original_key);
      watermarkedUrl = original;
      thumbnailUrl = original;
    } else {
      [watermarkedUrl, thumbnailUrl] = await Promise.all([
        resolveObjectUrl(r.watermarked_url),
        resolveObjectUrl(r.thumbnail_url),
      ]);
    }
  } else {
    // Photographer-facing: always show the ORIGINAL upload, regardless of
    // photo lifecycle. This covers two cases:
    //   1) status='uploaded' — the watermark Lambda has not run yet, so the
    //      watermarked/thumbnail keys are NULL and the gallery would otherwise
    //      render an empty <img>. Showing the original lets the photographer
    //      review the upload immediately.
    //   2) status='ready' — the photographer should still see the clean
    //      original from their dashboard. The watermarked variant exists only
    //      to be served to the client (see Gallery.tsx on the SPA).
    const original = await signOriginalUrl(r.original_key);
    watermarkedUrl = original;
    thumbnailUrl = original;
  }

  return {
    id: String(r.id),
    portfolioId: String(r.portfolio_id),
    // Never leak the S3 key of the original to the client; that key is the
    // path used to issue presigned GETs against the unwatermarked file.
    originalKey: forClient ? "" : String(r.original_key),
    watermarkedUrl,
    thumbnailUrl,
    uploadedAt: new Date(r.uploaded_at as string).toISOString(),
    status: r.status as PhotoStatus,
    purchased,
  };
}

export function mapPhotos(
  rows: Record<string, unknown>[],
  forClient: boolean,
  purchasedPhotoIds?: Set<string>,
): Promise<MappedPhoto[]> {
  return Promise.all(rows.map((row) => mapPhoto(row, forClient, purchasedPhotoIds)));
}

export function mapPurchase(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    clientId: String(r.client_id),
    portfolioId: String(r.portfolio_id),
    photoIds: (r.photo_ids as string[]).map(String),
    total: Number(r.total),
    status: r.status as "pending" | "paid" | "failed",
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

export function mapAppUserToContract(u: AppUser) {
  return mapUser({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    avatar_url: u.avatarUrl,
    phone: u.phone,
    studio_name: u.studioName,
    bio: u.bio,
    created_at: u.createdAt,
  });
}
