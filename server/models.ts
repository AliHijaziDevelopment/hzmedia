import mongoose, { Schema, model, type InferSchemaType } from "mongoose";

const userSchema = new Schema({
  keycloakId: { type: String, index: true, unique: true, sparse: true },
  username: { type: String, lowercase: true, trim: true, index: true, sparse: true },
  firstName: { type: String, trim: true },
  lastName: { type: String, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true, index: true, unique: true },
  name: { type: String, required: true, trim: true },
  role: { type: String, enum: ["super_admin", "user"], default: "user", index: true },
  companyIds: [{ type: Schema.Types.ObjectId, ref: "Company" }],
  createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  status: { type: String, enum: ["active", "invited", "disabled"], default: "active" },
}, { timestamps: true, versionKey: false });

const companySchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  slug: { type: String, required: true, lowercase: true, trim: true, unique: true, index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true, versionKey: false });

const albumSchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 140 },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true, versionKey: false });
albumSchema.index({ companyId: 1, createdAt: -1 });

const mediaSchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
  albumId: { type: Schema.Types.ObjectId, ref: "Album", required: true, index: true },
  uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  objectKey: { type: String, required: true, unique: true },
  filename: { type: String, required: true, trim: true },
  mimeType: { type: String, required: true },
  bytes: { type: Number, required: true, min: 1 },
  kind: { type: String, enum: ["image", "video"], required: true },
  status: { type: String, enum: ["pending", "ready"], default: "pending", index: true },
}, { timestamps: true, versionKey: false });
mediaSchema.index({ albumId: 1, createdAt: -1 });

const activitySchema = new Schema({
  actorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  actorKeycloakId: { type: String, required: true },
  actorName: { type: String, required: true, trim: true },
  actorEmail: { type: String, required: true, lowercase: true, trim: true },
  companyId: { type: Schema.Types.ObjectId, ref: "Company", index: true },
  action: { type: String, enum: ["company.created", "user.created", "user.assigned", "album.created", "media.uploaded"], required: true, index: true },
  targetType: { type: String, enum: ["company", "user", "album", "media"], required: true },
  targetId: { type: Schema.Types.ObjectId, required: true },
  targetName: { type: String, required: true, trim: true },
  detail: { type: String, required: true, trim: true },
}, { timestamps: true, versionKey: false });
activitySchema.index({ companyId: 1, createdAt: -1 });
activitySchema.index({ createdAt: -1 });

export type UserDocument = InferSchemaType<typeof userSchema>;
export const User = mongoose.models.User ?? model("User", userSchema);
export const Company = mongoose.models.Company ?? model("Company", companySchema);
export const Album = mongoose.models.Album ?? model("Album", albumSchema);
export const Media = mongoose.models.Media ?? model("Media", mediaSchema);
export const Activity = mongoose.models.Activity ?? model("Activity", activitySchema);
