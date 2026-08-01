import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";
import { env } from "./config.js";

export type AuthContext = { subject: string; email: string; name: string; isSuperAdmin: boolean };
type SessionAuth = AuthContext & { accessToken: string; refreshToken: string; expiresAt: number };
type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number };

declare global {
  namespace Express { interface Request { auth?: AuthContext } }
}

declare module "express-session" {
  interface SessionData { auth?: SessionAuth }
}

const issuer = env.KEYCLOAK_ISSUER.replace(/\/$/, "");
const tokenEndpoint = `${issuer}/protocol/openid-connect/token`;
const logoutEndpoint = `${issuer}/protocol/openid-connect/logout`;
const keys = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`), { cooldownDuration: 30_000, timeoutDuration: 5_000 });
const credentialsSchema = z.object({ username: z.string().trim().min(1).max(254), password: z.string().min(1).max(1024) });

export async function login(request: Request, response: Response) {
  const credentials = credentialsSchema.parse(request.body);
  let tokens: TokenResponse;
  try {
    tokens = await requestTokens({ grant_type: "password", username: credentials.username, password: credentials.password, scope: "openid profile email" });
  } catch {
    return response.status(401).json({ error: "Invalid username or password" });
  }
  if (!tokens.refresh_token) return response.status(401).json({ error: "Sign-in could not be completed" });
  const context = await verifyAccessToken(tokens.access_token);
  await regenerateSession(request);
  request.session.auth = { ...context, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + Math.max(30, tokens.expires_in ?? 300) * 1000 };
  await saveSession(request);
  response.set("Cache-Control", "private, no-store").json({ email: context.email, name: context.name, isSuperAdmin: context.isSuperAdmin });
}

export async function getSession(request: Request, response: Response) {
  const auth = await validSessionAuth(request);
  if (!auth) return response.status(401).json({ error: "Authentication required" });
  response.set("Cache-Control", "private, no-store").json({ email: auth.email, name: auth.name, isSuperAdmin: auth.isSuperAdmin });
}

export async function logout(request: Request, response: Response) {
  const refreshToken = request.session.auth?.refreshToken;
  if (refreshToken) {
    await fetch(logoutEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.KEYCLOAK_CLIENT_ID, client_secret: env.KEYCLOAK_CLIENT_SECRET, refresh_token: refreshToken }),
      signal: AbortSignal.timeout(8_000),
    }).catch(() => undefined);
  }
  await destroySession(request);
  response.clearCookie(env.SESSION_COOKIE_NAME, sessionCookieOptions());
  response.status(204).end();
}

export async function requireAuth(request: Request, response: Response, next: NextFunction) {
  try {
    const auth = await validSessionAuth(request);
    if (!auth) return response.status(401).json({ error: "Authentication required" });
    request.auth = auth;
    next();
  } catch {
    response.status(401).json({ error: "Session expired" });
  }
}

export function requireSuperAdmin(request: Request, response: Response, next: NextFunction) {
  if (!request.auth?.isSuperAdmin) return response.status(403).json({ error: "Super admin access required" });
  next();
}

export async function getKeycloakAccessToken(request: Request): Promise<string> {
  const auth = await validSessionAuth(request);
  if (!auth?.isSuperAdmin) throw new Error("Super admin session required");
  return auth.accessToken;
}

export function sessionCookieOptions() {
  return { httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "lax" as const, path: "/" };
}

async function validSessionAuth(request: Request): Promise<SessionAuth | null> {
  const existing = request.session.auth;
  if (!existing) return null;
  if (existing.accessToken && existing.expiresAt > Date.now() + 30_000) return existing;
  try {
    const tokens = await requestTokens({ grant_type: "refresh_token", refresh_token: existing.refreshToken });
    const context = await verifyAccessToken(tokens.access_token);
    request.session.auth = { ...context, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? existing.refreshToken, expiresAt: Date.now() + Math.max(30, tokens.expires_in ?? 300) * 1000 };
    await saveSession(request);
    return request.session.auth;
  } catch {
    await destroySession(request);
    return null;
  }
}

async function verifyAccessToken(token: string): Promise<AuthContext> {
  const { payload } = await jwtVerify(token, keys, { issuer, clockTolerance: 5 });
  assertClient(payload);
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!payload.sub || !email) throw new Error("Keycloak token is missing required claims");
  const realmAccess = payload.realm_access as { roles?: unknown } | undefined;
  const roles = Array.isArray(realmAccess?.roles) ? realmAccess.roles.filter((role): role is string => typeof role === "string") : [];
  return { subject: payload.sub, email, name: typeof payload.name === "string" ? payload.name : email, isSuperAdmin: roles.includes("super_admin") };
}

function assertClient(payload: JWTPayload) {
  const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!audiences.includes(env.KEYCLOAK_CLIENT_ID) && payload.azp !== env.KEYCLOAK_CLIENT_ID) throw new Error("Token was not issued for this application");
}

async function requestTokens(parameters: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ ...parameters, client_id: env.KEYCLOAK_CLIENT_ID, client_secret: env.KEYCLOAK_CLIENT_SECRET }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("Keycloak token request failed");
  const result = await response.json() as TokenResponse;
  if (!result.access_token) throw new Error("Keycloak did not return an access token");
  return result;
}

function saveSession(request: Request) { return new Promise<void>((resolve, reject) => request.session.save((error) => error ? reject(error) : resolve())); }
function regenerateSession(request: Request) { return new Promise<void>((resolve, reject) => request.session.regenerate((error) => error ? reject(error) : resolve())); }
function destroySession(request: Request) { return new Promise<void>((resolve) => request.session.destroy(() => resolve())); }
