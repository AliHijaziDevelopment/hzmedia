import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().min(1),
  WEB_ORIGINS: z.string().default("http://localhost:3000"),
  KEYCLOAK_ISSUER: z.string().url(),
  KEYCLOAK_CLIENT_ID: z.string().min(1),
  KEYCLOAK_CLIENT_SECRET: z.string().min(16),
  SESSION_SECRET: z.string().min(32),
  SESSION_COOKIE_NAME: z.string().min(3).default("framevault.sid"),
  R2_ACCOUNT_ID: z.string().trim().min(8),
  R2_BUCKET: z.string().trim().min(3),
  R2_ACCESS_KEY_ID: z.string().trim().min(8),
  R2_SECRET_ACCESS_KEY: z.string().trim().min(8),
});

export const env = schema.parse(process.env);
export const allowedOrigins = env.WEB_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);
