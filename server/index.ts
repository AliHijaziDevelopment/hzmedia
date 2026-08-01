import crypto from "node:crypto";
import { createServer, ServerResponse as NodeServerResponse } from "node:http";
import { createRequire } from "node:module";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import session from "express-session";
import MongoStore from "connect-mongo";
import mongoose from "mongoose";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { allowedOrigins, env } from "./config.js";
import { getKeycloakAccessToken, getSession, login, logout, requireAuth, requireSuperAdmin, sessionCookieOptions } from "./auth.js";
import { createKeycloakUser, deleteKeycloakUser, KeycloakAdminError } from "./keycloak-admin.js";
import { Activity, Album, Company, Media, User } from "./models.js";
import { streamAlbumZip } from "./zip-stream.js";

const { WebSocketServer } = createRequire(import.meta.url)("ws") as { WebSocketServer: new (options: { noServer: boolean }) => any };
const liveClients = new Map<string, Set<any>>();

function emitToUser(subject: string, event: unknown) {
  const message = JSON.stringify(event);
  for (const client of liveClients.get(subject) ?? []) if (client.readyState === 1) client.send(message);
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin(origin, callback) { callback(null, !origin || allowedOrigins.includes(origin)); }, credentials: true, maxAge: 86_400 }));
app.use(express.json({ limit: "256kb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false }));
const sessionMiddleware = session({
  name: env.SESSION_COOKIE_NAME,
  secret: env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { ...sessionCookieOptions(), maxAge: 8 * 60 * 60 * 1000 },
  store: MongoStore.create({ mongoUrl: env.MONGODB_URI, collectionName: "sessions", ttl: 8 * 60 * 60, touchAfter: 60, crypto: { secret: env.SESSION_SECRET } }),
});
app.use(sessionMiddleware);

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});
const asyncRoute = (handler: (request: Request, response: Response) => Promise<unknown>) => (request: Request, response: Response, next: NextFunction) => { Promise.resolve(handler(request, response)).catch(next); };
const objectId = z.string().regex(/^[a-f\d]{24}$/i);

async function currentUser(request: Request) {
  const auth = request.auth!;
  return User.findOneAndUpdate({ email: auth.email }, { $set: { keycloakId: auth.subject, name: auth.name, role: auth.isSuperAdmin ? "super_admin" : "user", status: "active" } }, { new: true, upsert: true, setDefaultsOnInsert: true });
}

async function canAccessCompany(request: Request, companyId: string) {
  if (request.auth?.isSuperAdmin) return true;
  const user = await currentUser(request);
  return user.companyIds.some((id: mongoose.Types.ObjectId) => id.equals(companyId));
}

async function recordActivity(actor: Awaited<ReturnType<typeof currentUser>>, entry: { companyId?: string | mongoose.Types.ObjectId; action: "company.created" | "user.created" | "user.assigned" | "album.created" | "media.uploaded"; targetType: "company" | "user" | "album" | "media"; targetId: string | mongoose.Types.ObjectId; targetName: string; detail: string }) {
  try {
    await Activity.create({ actorId: actor._id, actorKeycloakId: actor.keycloakId, actorName: actor.name, actorEmail: actor.email, ...entry });
  } catch (error) {
    console.error("Could not record activity", error);
  }
}

app.get("/health", (_request, response) => response.json({ ok: true }));
app.get("/auth/session", asyncRoute(getSession));
const trustedBrowserRequest = (request: Request, response: Response, next: NextFunction) => {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.includes(origin) || request.get("X-HZ-Media-Request") !== "1") return response.status(403).json({ error: "Untrusted request origin" });
  next();
};
app.post("/auth/login", rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: "draft-7", legacyHeaders: false }), trustedBrowserRequest, asyncRoute(login));
app.post("/auth/logout", trustedBrowserRequest, asyncRoute(logout));
app.use("/api", (request, response, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
  trustedBrowserRequest(request, response, next);
});
app.use("/api", requireAuth);

app.get("/api/me", asyncRoute(async (request, response) => {
  const user = await currentUser(request);
  response.json({ id: user.id, email: user.email, name: user.name, role: user.role, companyIds: user.companyIds });
}));

app.get("/api/companies", asyncRoute(async (request, response) => {
  const user = await currentUser(request);
  const filter = request.auth?.isSuperAdmin ? {} : { _id: { $in: user.companyIds } };
  const companies = await Company.find(filter).sort({ createdAt: -1 }).lean();
  const enriched = await Promise.all(companies.map(async (company) => {
    const [memberCount, albumCount, storage] = await Promise.all([
      User.countDocuments({ companyIds: company._id, status: { $ne: "disabled" } }),
      Album.countDocuments({ companyId: company._id }),
      Media.aggregate<{ bytes: number }>([{ $match: { companyId: company._id, status: "ready" } }, { $group: { _id: null, bytes: { $sum: "$bytes" } } }]),
    ]);
    return { ...company, memberCount, albumCount, storageBytes: storage[0]?.bytes ?? 0 };
  }));
  response.json({ companies: enriched });
}));

app.post("/api/companies", requireSuperAdmin, asyncRoute(async (request, response) => {
  const input = z.object({ name: z.string().trim().min(2).max(120) }).parse(request.body);
  const user = await currentUser(request);
  const baseSlug = input.name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 70) || "company";
  const company = await Company.create({ name: input.name, slug: `${baseSlug}-${crypto.randomBytes(3).toString("hex")}`, createdBy: user._id });
  await recordActivity(user, { companyId: company._id, action: "company.created", targetType: "company", targetId: company._id, targetName: company.name, detail: `Created company ${company.name}` });
  response.status(201).json({ company });
}));

app.get("/api/users", requireSuperAdmin, asyncRoute(async (_request, response) => {
  const users = await User.find({ role: "user", status: { $ne: "disabled" } })
    .select("username firstName lastName email name companyIds status createdAt")
    .sort({ firstName: 1, lastName: 1, email: 1 })
    .lean();
  response.set("Cache-Control", "private, no-store").json({ users });
}));

app.post("/api/users", requireSuperAdmin, rateLimit({ windowMs: 60 * 60_000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false }), asyncRoute(async (request, response) => {
  const input = z.object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    username: z.string().trim().min(3).max(80).regex(/^[a-zA-Z0-9._@-]+$/),
    email: z.string().email().transform((value) => value.toLowerCase()),
    password: z.string().min(8).max(128),
  }).parse(request.body);
  const existing = await User.exists({ $or: [{ email: input.email }, { username: input.username.toLowerCase() }] });
  if (existing) return response.status(409).json({ error: "A user with that username or email already exists" });
  const accessToken = await getKeycloakAccessToken(request);
  const keycloakId = await createKeycloakUser(accessToken, input);
  try {
    const actor = await currentUser(request);
    const user = await User.create({
      keycloakId,
      username: input.username.toLowerCase(),
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      name: `${input.firstName} ${input.lastName}`,
      role: "user",
      companyIds: [],
      createdBy: actor._id,
      status: "active",
    });
    await recordActivity(actor, { action: "user.created", targetType: "user", targetId: user._id, targetName: user.name, detail: `Created user ${user.name}` });
    response.status(201).json({ user });
  } catch (error) {
    await deleteKeycloakUser(accessToken, keycloakId);
    throw error;
  }
}));

app.post("/api/companies/:companyId/members", requireSuperAdmin, asyncRoute(async (request, response) => {
  const companyId = objectId.parse(request.params.companyId);
  const input = z.object({ userId: objectId }).parse(request.body);
  const company = await Company.findById(companyId).select("name").lean();
  if (!company) return response.status(404).json({ error: "Company not found" });
  const user = await User.findOneAndUpdate({ _id: input.userId, role: "user", status: { $ne: "disabled" }, companyIds: { $ne: companyId } }, { $addToSet: { companyIds: companyId } }, { new: true });
  if (!user) {
    const existingUser = await User.findOne({ _id: input.userId, role: "user", status: { $ne: "disabled" } });
    if (existingUser?.companyIds.some((id: mongoose.Types.ObjectId) => id.equals(companyId))) return response.status(200).json({ user: existingUser });
  }
  if (!user) return response.status(404).json({ error: "User not found" });
  const actor = await currentUser(request);
  await recordActivity(actor, { companyId, action: "user.assigned", targetType: "user", targetId: user._id, targetName: user.name, detail: `Assigned ${user.name} to ${company.name}` });
  response.status(200).json({ user });
}));

app.get("/api/activity", asyncRoute(async (request, response) => {
  const viewer = await currentUser(request);
  const companyFilter = request.auth?.isSuperAdmin ? {} : { companyId: { $in: viewer.companyIds } };
  const [recorded, legacyCompanies, legacyAlbums] = await Promise.all([
    Activity.find(companyFilter).sort({ createdAt: -1 }).limit(200).lean(),
    Company.find(request.auth?.isSuperAdmin ? {} : { _id: { $in: viewer.companyIds } }).select("name createdBy createdAt").populate("createdBy", "name email").lean(),
    Album.find(request.auth?.isSuperAdmin ? {} : { companyId: { $in: viewer.companyIds } }).select("name companyId createdBy createdAt").populate("createdBy", "name email").lean(),
  ]);
  const recordedKeys = new Set(recorded.map((item) => `${item.action}:${item.targetId}`));
  const actor = (value: unknown) => {
    const creator = value as { name?: string; email?: string } | null;
    return { name: creator?.name ?? "Unknown user", email: creator?.email ?? "" };
  };
  const legacy = [
    ...legacyCompanies.filter((company) => !recordedKeys.has(`company.created:${company._id}`)).map((company) => ({ _id: `legacy-company-${company._id}`, action: "company.created", targetType: "company", targetName: company.name, companyId: company._id, detail: `Created company ${company.name}`, actor: actor(company.createdBy), createdAt: company.createdAt })),
    ...legacyAlbums.filter((album) => !recordedKeys.has(`album.created:${album._id}`)).map((album) => ({ _id: `legacy-album-${album._id}`, action: "album.created", targetType: "album", targetName: album.name, companyId: album.companyId, detail: `Created album ${album.name}`, actor: actor(album.createdBy), createdAt: album.createdAt })),
  ];
  const entries = recorded.map((item) => ({ _id: item._id, action: item.action, targetType: item.targetType, targetName: item.targetName, companyId: item.companyId, detail: item.detail, actor: { name: item.actorName, email: item.actorEmail }, createdAt: item.createdAt }));
  const activity = [...entries, ...legacy].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()).slice(0, 200);
  response.set("Cache-Control", "private, no-store").json({ activity });
}));

app.get("/api/companies/:companyId/albums", asyncRoute(async (request, response) => {
  const companyId = objectId.parse(request.params.companyId);
  if (!await canAccessCompany(request, companyId)) return response.status(403).json({ error: "Company access denied" });
  const albums = await Album.find({ companyId }).sort({ createdAt: -1 }).lean();
  const enriched = await Promise.all(albums.map(async (album) => ({ ...album, itemCount: await Media.countDocuments({ albumId: album._id, status: "ready" }) })));
  response.json({ albums: enriched });
}));

app.post("/api/companies/:companyId/albums", asyncRoute(async (request, response) => {
  const companyId = objectId.parse(request.params.companyId);
  const input = z.object({ name: z.string().trim().min(1).max(140) }).parse(request.body);
  if (!await canAccessCompany(request, companyId)) return response.status(403).json({ error: "Company access denied" });
  const user = await currentUser(request);
  const album = await Album.create({ companyId, name: input.name, createdBy: user._id });
  await recordActivity(user, { companyId, action: "album.created", targetType: "album", targetId: album._id, targetName: album.name, detail: `Created album ${album.name}` });
  response.status(201).json({ album });
}));

app.get("/api/albums/:albumId/media", asyncRoute(async (request, response) => {
  const albumId = objectId.parse(request.params.albumId);
  const album = await Album.findById(albumId).lean();
  if (!album) return response.status(404).json({ error: "Album not found" });
  if (!await canAccessCompany(request, String(album.companyId))) return response.status(403).json({ error: "Album access denied" });
  const media = await Media.find({ albumId, status: "ready" }).sort({ createdAt: -1 }).lean();
  const withPrivateUrls = await Promise.all(media.map(async (item) => ({
    ...item,
    url: await getSignedUrl(r2, new GetObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: item.objectKey,
      ResponseContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(item.filename)}`,
      ResponseContentType: item.mimeType,
    }), { expiresIn: 900 }),
    urlExpiresIn: 900,
  })));
  response.set("Cache-Control", "private, no-store").json({ media: withPrivateUrls });
}));

app.get("/api/albums/:albumId/download", rateLimit({ windowMs: 60 * 60_000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false }), asyncRoute(async (request, response) => {
  const albumId = objectId.parse(request.params.albumId);
  const album = await Album.findById(albumId).select("companyId name").lean();
  if (!album) return response.status(404).json({ error: "Album not found" });
  if (!await canAccessCompany(request, String(album.companyId))) return response.status(403).json({ error: "Album access denied" });
  const files = await Media.find({ albumId, status: "ready" }).select("objectKey filename bytes updatedAt").sort({ createdAt: 1 }).lean();
  await streamAlbumZip(response, r2, env.R2_BUCKET, files, album.name);
}));

app.post("/api/albums/:albumId/uploads", rateLimit({ windowMs: 60_000, limit: 30 }), asyncRoute(async (request, response) => {
  const albumId = objectId.parse(request.params.albumId);
  const input = z.object({ filename: z.string().trim().min(1).max(180), mimeType: z.string().regex(/^(image|video)\/[a-z0-9.+-]+$/i), bytes: z.number().int().positive().max(500 * 1024 * 1024) }).parse(request.body);
  const album = await Album.findById(albumId).lean();
  if (!album) return response.status(404).json({ error: "Album not found" });
  if (!await canAccessCompany(request, String(album.companyId))) return response.status(403).json({ error: "Album access denied" });
  const user = await currentUser(request);
  const extension = input.filename.split(".").pop()?.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin";
  const objectKey = `${album.companyId}/${albumId}/${crypto.randomUUID()}.${extension}`;
  const media = await Media.create({ companyId: album.companyId, albumId, uploadedBy: user._id, objectKey, filename: input.filename, mimeType: input.mimeType, bytes: input.bytes, kind: input.mimeType.startsWith("image/") ? "image" : "video" });
  const uploadUrl = await getSignedUrl(r2, new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: objectKey, ContentType: input.mimeType }), { expiresIn: 300 });
  response.status(201).json({ mediaId: media.id, uploadUrl, expiresIn: 300 });
}));

app.post("/api/media/:mediaId/complete", asyncRoute(async (request, response) => {
  const mediaId = objectId.parse(request.params.mediaId);
  const input = z.object({ uploadId: z.string().trim().min(1).max(80).optional() }).parse(request.body ?? {});
  const media = await Media.findById(mediaId);
  if (!media) return response.status(404).json({ error: "Media not found" });
  if (!await canAccessCompany(request, String(media.companyId))) return response.status(403).json({ error: "Media access denied" });
  const uploaded = await r2.send(new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: media.objectKey }));
  const hasExpectedSize = uploaded.ContentLength === media.bytes;
  const hasExpectedType = uploaded.ContentType?.toLowerCase() === media.mimeType.toLowerCase();
  if (!hasExpectedSize || !hasExpectedType) {
    await r2.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: media.objectKey }));
    await media.deleteOne();
    return response.status(400).json({ error: "Uploaded file did not match the requested size or media type" });
  }
  const wasReady = media.status === "ready";
  media.status = "ready";
  await media.save();
  if (!wasReady) {
    const actor = await currentUser(request);
    await recordActivity(actor, { companyId: media.companyId, action: "media.uploaded", targetType: "media", targetId: media._id, targetName: media.filename, detail: `Uploaded ${media.filename}` });
  }
  emitToUser(request.auth!.subject, { type: "upload:complete", uploadId: input.uploadId, mediaId: media.id, filename: media.filename, progress: 100 });
  response.json({ media });
}));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (response.headersSent) { response.destroy(); return; }
  if (error instanceof z.ZodError) return response.status(400).json({ error: "Invalid request", details: error.flatten() });
  if (error instanceof KeycloakAdminError) return response.status(error.status).json({ error: error.message });
  if (error instanceof mongoose.Error.ValidationError) return response.status(400).json({ error: "Invalid data" });
  console.error(error);
  response.status(500).json({ error: "Unexpected server error" });
});

await mongoose.connect(env.MONGODB_URI, { maxPoolSize: 20, minPoolSize: 2, serverSelectionTimeoutMS: 5_000 });
const httpServer = createServer(app);
const liveServer = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (request, socket, head) => {
  const origin = request.headers.origin;
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (path !== "/live" || !origin || !allowedOrigins.includes(origin)) { socket.destroy(); return; }
  const sessionResponse = new NodeServerResponse(request);
  sessionMiddleware(request as unknown as Request, sessionResponse as unknown as Response, () => {
    const subject = (request as typeof request & { session?: { auth?: { subject?: string } } }).session?.auth?.subject;
    if (!subject) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    liveServer.handleUpgrade(request, socket, head, (client: any) => liveServer.emit("connection", client, subject));
  });
});
liveServer.on("connection", (client: any, subject: string) => {
  const clients = liveClients.get(subject) ?? new Set<any>();
  clients.add(client);
  liveClients.set(subject, clients);
  client.on("message", (raw: Buffer) => {
    try {
      const parsed = z.object({ type: z.literal("upload:progress"), uploadId: z.string().trim().min(1).max(80), filename: z.string().trim().min(1).max(180), progress: z.number().int().min(0).max(100), status: z.enum(["preparing", "uploading", "processing", "complete", "error"]) }).safeParse(JSON.parse(raw.toString("utf8")));
      if (parsed.success) emitToUser(subject, parsed.data);
    } catch { /* Ignore malformed socket messages. */ }
  });
  client.on("close", () => { clients.delete(client); if (!clients.size) liveClients.delete(subject); });
});
httpServer.listen(env.PORT, () => console.log(`HZ Media API listening on ${env.PORT}`));

async function shutdown() { await mongoose.disconnect(); process.exit(0); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
