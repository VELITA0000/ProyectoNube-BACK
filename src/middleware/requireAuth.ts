import type { Request, Response, NextFunction } from "express";
import { verifyIdToken } from "../auth/jwt.js";
import { HttpError } from "../http/errors.js";
import { getPool } from "../db/pool.js";

export interface AppUser {
  id: string;
  cognitoSub: string;
  email: string;
  name: string;
  role: "photographer" | "client";
  avatarUrl?: string;
  phone?: string;
  studioName?: string;
  bio?: string;
  createdAt: string;
}

// `Request` is exported from `@types/express` as a member of the `Express`
// namespace, so module augmentation MUST go through the same namespace.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      appUser?: AppUser;
    }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) {
    return next(new HttpError(401, "UNAUTHORIZED", "Missing authorization token"));
  }
  const token = h.slice(7);
  try {
    const payload = await verifyIdToken(token);
    const sub = String(payload.sub ?? "");
    if (!sub) throw new Error("Token missing sub");

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, cognito_sub, email, name, role, avatar_url, phone, studio_name, bio, created_at
       FROM users WHERE cognito_sub = $1`,
      [sub],
    );
    if (rows.length === 0) {
      return next(
        new HttpError(401, "USER_NOT_SYNCED", "User not synced in database"),
      );
    }
    const r = rows[0];
    req.appUser = {
      id: r.id,
      cognitoSub: r.cognito_sub,
      email: r.email,
      name: r.name,
      role: r.role,
      avatarUrl: r.avatar_url ?? undefined,
      phone: r.phone ?? undefined,
      studioName: r.studio_name ?? undefined,
      bio: r.bio ?? undefined,
      createdAt: new Date(r.created_at).toISOString(),
    };
    next();
  } catch (e) {
    if (e instanceof HttpError) return next(e);
    return next(new HttpError(401, "INVALID_TOKEN", "Invalid or expired token"));
  }
}

export function requireRole(...roles: ("photographer" | "client")[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const u = req.appUser;
    if (!u) return next(new HttpError(401, "UNAUTHORIZED", "Not authenticated"));
    if (!roles.includes(u.role)) {
      return next(new HttpError(403, "FORBIDDEN", "Role not allowed for this operation"));
    }
    next();
  };
}
