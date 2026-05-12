import { Router } from "express";
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  GetUserCommand,
  InitiateAuthCommand,
  GlobalSignOutCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { getCognito } from "../aws/clients.js";
import { getEnv } from "../config/env.js";
import { getPool } from "../db/pool.js";
import { HttpError } from "../http/errors.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { mapAppUserToContract, mapUser } from "../domain/mappers.js";

export const authRouter = Router();

function cognitoSubFromGetUser(gu: {
  UserAttributes?: { Name?: string; Value?: string }[];
  Username?: string;
}): string {
  const subAttr = gu.UserAttributes?.find((a) => a.Name === "sub");
  if (subAttr?.Value) return subAttr.Value;
  if (gu.Username) return gu.Username;
  return "";
}

authRouter.post("/signup", async (req, res, next) => {
  try {
    const { email, password, name, role, phone, studioName } = req.body ?? {};
    if (!email || !password || !name || !role) {
      throw new HttpError(422, "VALIDATION", "email, password, name, and role are required");
    }
    if (role !== "photographer" && role !== "client") {
      throw new HttpError(422, "VALIDATION", "invalid role");
    }
    const env = getEnv();
    const cognito = getCognito();
    const pool = getPool();

    try {
      await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: env.COGNITO_USER_POOL_ID,
          Username: email,
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
            { Name: "name", Value: name },
            { Name: "custom:role", Value: role },
          ],
          MessageAction: "SUPPRESS",
        }),
      );
    } catch (e: unknown) {
      const nameErr = e && typeof e === "object" && "name" in e ? String((e as { name: string }).name) : "";
      if (nameErr === "UsernameExistsException") {
        throw new HttpError(409, "EMAIL_TAKEN", "An account with this email already exists");
      }
      throw e;
    }

    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: env.COGNITO_USER_POOL_ID,
        Username: email,
        Password: password,
        Permanent: true,
      }),
    );

    const gu = await cognito.send(
      new AdminGetUserCommand({
        UserPoolId: env.COGNITO_USER_POOL_ID,
        Username: email,
      }),
    );
    const cognitoSub = cognitoSubFromGetUser(gu);
    if (!cognitoSub) throw new HttpError(500, "INTERNAL", "Could not obtain cognito_sub");

    const { rows } = await pool.query(
      `INSERT INTO users (cognito_sub, email, name, role, phone, studio_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [cognitoSub, email, name, role, phone ?? null, role === "photographer" ? studioName ?? null : null],
    );

    const auth = await cognito.send(
      new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: env.COGNITO_CLIENT_ID,
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
        },
      }),
    );
    const idToken = auth.AuthenticationResult?.IdToken;
    const accessToken = auth.AuthenticationResult?.AccessToken;
    if (!idToken) throw new HttpError(500, "INTERNAL", "Cognito did not return tokens");

    res.status(201).json({
      user: mapUser(rows[0]),
      idToken,
      accessToken,
      refreshToken: auth.AuthenticationResult?.RefreshToken,
    });
  } catch (e) {
    next(e);
  }
});

authRouter.post("/signin", async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      throw new HttpError(422, "VALIDATION", "email and password are required");
    }
    const env = getEnv();
    const cognito = getCognito();
    let auth;
    try {
      auth = await cognito.send(
        new InitiateAuthCommand({
          AuthFlow: "USER_PASSWORD_AUTH",
          ClientId: env.COGNITO_CLIENT_ID,
          AuthParameters: { USERNAME: email, PASSWORD: password },
        }),
      );
    } catch {
      throw new HttpError(401, "INVALID_CREDENTIALS", "Incorrect email or password");
    }
    const idToken = auth.AuthenticationResult?.IdToken;
    const accessToken = auth.AuthenticationResult?.AccessToken;
    if (!idToken || !accessToken) {
      throw new HttpError(401, "INVALID_CREDENTIALS", "Incorrect email or password");
    }

    const gu = await cognito.send(new GetUserCommand({ AccessToken: accessToken }));
    const sub = cognitoSubFromGetUser(gu);
    const pool = getPool();
    const { rows } = await pool.query(`SELECT * FROM users WHERE cognito_sub = $1`, [sub]);
    if (rows.length === 0) {
      throw new HttpError(401, "USER_NOT_SYNCED", "Profile not found in database");
    }
    res.json({
      user: mapUser(rows[0]),
      idToken,
      accessToken,
      refreshToken: auth.AuthenticationResult?.RefreshToken,
    });
  } catch (e) {
    next(e);
  }
});

authRouter.post("/signout", requireAuth, async (req, res, next) => {
  try {
    const accessTokenFromBody = typeof req.body?.accessToken === "string" ? req.body.accessToken : "";
    const authHeader = req.headers.authorization;
    const tokenFromHeader = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const accessToken = accessTokenFromBody || tokenFromHeader;
    if (accessToken) {
      const cognito = getCognito();
      await cognito.send(new GlobalSignOutCommand({ AccessToken: accessToken }));
    }
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

authRouter.post("/refresh", async (req, res, next) => {
  try {
    const { refreshToken } = req.body ?? {};
    if (!refreshToken || typeof refreshToken !== "string") {
      throw new HttpError(422, "VALIDATION", "refreshToken is required");
    }
    const env = getEnv();
    const cognito = getCognito();
    const auth = await cognito.send(
      new InitiateAuthCommand({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: env.COGNITO_CLIENT_ID,
        AuthParameters: {
          REFRESH_TOKEN: refreshToken,
        },
      }),
    );
    const idToken = auth.AuthenticationResult?.IdToken;
    const accessToken = auth.AuthenticationResult?.AccessToken;
    if (!idToken || !accessToken) {
      throw new HttpError(401, "INVALID_REFRESH_TOKEN", "Could not refresh session");
    }
    res.json({
      idToken,
      accessToken,
      refreshToken: auth.AuthenticationResult?.RefreshToken ?? refreshToken,
    });
  } catch (e) {
    next(e);
  }
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json(mapAppUserToContract(req.appUser!));
});

authRouter.patch("/me", requireAuth, async (req, res, next) => {
  try {
    const u = req.appUser!;
    const { name, avatarUrl, studioName, bio, phone } = req.body ?? {};
    const pool = getPool();
    const { rows } = await pool.query(
      `UPDATE users SET
         name = COALESCE($2, name),
         avatar_url = COALESCE($3, avatar_url),
         studio_name = COALESCE($4, studio_name),
         bio = COALESCE($5, bio),
         phone = COALESCE($6, phone)
       WHERE id = $1
       RETURNING *`,
      [u.id, name ?? null, avatarUrl ?? null, studioName ?? null, bio ?? null, phone ?? null],
    );
    const cognito = getCognito();
    const env = getEnv();
    const attrs: { Name: string; Value: string }[] = [];
    if (typeof name === "string") attrs.push({ Name: "name", Value: name });
    if (attrs.length) {
      await cognito.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: env.COGNITO_USER_POOL_ID,
          Username: u.email,
          UserAttributes: attrs,
        }),
      );
    }
    res.json(mapUser(rows[0]));
  } catch (e) {
    next(e);
  }
});
