import { Schema, model } from "mongoose";

const liveSessionSchema = new Schema({
  hostId: { type: String, required: true, index: true },
  title: { type: String, required: true, maxlength: 180 },
  roomName: { type: String, required: true, unique: true },
  startAt: { type: Date, required: true, index: true },
  endedAt: { type: Date, default: null },
  status: { type: String, enum: ["scheduled", "live", "ended"], default: "scheduled", index: true },
  waitingRoom: { type: Boolean, default: true },
  maxParticipants: { type: Number, default: 500 },
  activeParticipants: { type: Number, default: 0 },
  maxGuests: { type: Number, default: 100 },
  activeGuests: { type: Number, default: 0 },
  recordingEgressId: { type: String, default: null },
  recordingPath: { type: String, default: null },
  recordingStatus: { type: String, enum: ["off", "starting", "recording", "stopping", "ready", "failed"], default: "off" }
}, { timestamps: true, collection: "live_sessions" });
liveSessionSchema.index({ hostId: 1, startAt: -1, _id: -1 });

const invitationSchema = new Schema({
  sessionId: { type: Schema.Types.ObjectId, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true, select: false },
  emailHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  maxUses: { type: Number, default: 1 },
  uses: { type: Number, default: 0 },
  createdBy: { type: String, required: true }
}, { timestamps: true, collection: "invitations" });
invitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
invitationSchema.index({ sessionId: 1, expiresAt: 1 });

const participantSchema = new Schema({
  sessionId: { type: Schema.Types.ObjectId, required: true, index: true },
  identity: { type: String, required: true },
  userId: { type: String, default: null, index: true },
  invitationId: { type: Schema.Types.ObjectId, default: null },
  emailHash: { type: String, default: null },
  role: { type: String, enum: ["host", "instructor", "student", "guest"], required: true },
  status: { type: String, enum: ["waiting", "active", "removed", "left"], default: "active" },
  joinedAt: { type: Date, default: Date.now },
  leftAt: { type: Date, default: null }
}, { timestamps: true, collection: "participants" });
participantSchema.index({ sessionId: 1, identity: 1 }, { unique: true });
participantSchema.index({ sessionId: 1, status: 1, joinedAt: -1 });

const recordingsSchema = new Schema({
  sessionId: { type: Schema.Types.ObjectId, required: true, unique: true },
  egressId: { type: String, required: true, unique: true },
  objectPath: { type: String, required: true },
  status: { type: String, enum: ["recording", "ready", "failed"], default: "recording" },
  durationSeconds: { type: Number, default: 0 },
  sizeBytes: { type: Number, default: 0 }
}, { timestamps: true, collection: "recordings_meta" });

export const LiveSessionModel = model("LiveSession", liveSessionSchema);
export const InvitationModel = model("Invitation", invitationSchema);
export const ParticipantModel = model("Participant", participantSchema);
export const RecordingModel = model("Recording", recordingsSchema);
