import * as jose from "jose";
import { getEnv } from "../config/env.js";

let jwks: jose.JWTVerifyGetKey | null = null;
let jwksIssuer: string | null = null;

function activeIssuer(): string {
  const env = getEnv();
  return `https://cognito-idp.${env.AWS_REGION}.amazonaws.com/${env.COGNITO_USER_POOL_ID}`;
}

function getJwks(): jose.JWTVerifyGetKey {
  const issuer = activeIssuer();
  if (!jwks || jwksIssuer !== issuer) {
    jwks = jose.createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    jwksIssuer = issuer;
  }
  return jwks;
}

export async function verifyIdToken(token: string): Promise<jose.JWTPayload> {
  const env = getEnv();
  const issuer = activeIssuer();
  const { payload } = await jose.jwtVerify(token, getJwks(), {
    issuer,
    audience: env.COGNITO_CLIENT_ID,
  });
  return payload;
}

export function roleFromPayload(payload: jose.JWTPayload): "photographer" | "client" {
  const custom = payload["custom:role"] as string | undefined;
  if (custom === "photographer" || custom === "client") return custom;
  return "client";
}
