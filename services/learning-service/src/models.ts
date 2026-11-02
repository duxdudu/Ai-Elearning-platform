import { Schema, model } from "mongoose";

const courseSchema = new Schema({
  instructorId: { type: String, required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 180 },
  description: { type: String, required: true, maxlength: 20_000 },
  category: { type: String, required: true, index: true },
  tags: { type: [String], default: [] },
  published: { type: Boolean, default: false, index: true },
  enrollmentCount: { type: Number, default: 0 },
  averageRating: { type: Number, default: 0 },
  reviewCount: { type: Number, default: 0 },
  lessonCount: { type: Number, default: 0 }
}, { timestamps: true, collection: "courses" });
courseSchema.index({ published: 1, createdAt: -1, _id: -1 });
courseSchema.index({ instructorId: 1, createdAt: -1, _id: -1 });
courseSchema.index({ category: 1, published: 1, createdAt: -1, _id: -1 });

const lessonSchema = new Schema({
  courseId: { type: Schema.Types.ObjectId, required: true, index: true },
  title: { type: String, required: true, maxlength: 180 },
  content: { type: String, required: true, maxlength: 100_000 },
  order: { type: Number, required: true },
  durationSeconds: { type: Number, default: 0 }
}, { timestamps: true, collection: "lessons" });
lessonSchema.index({ courseId: 1, order: 1, _id: 1 }, { unique: true });

const enrollmentSchema = new Schema({
  userId: { type: String, required: true },
  courseId: { type: Schema.Types.ObjectId, required: true },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false, collection: "enrollments" });
enrollmentSchema.index({ userId: 1, courseId: 1 }, { unique: true });
enrollmentSchema.index({ courseId: 1, createdAt: -1, _id: -1 });
enrollmentSchema.index({ userId: 1, createdAt: -1, _id: -1 });

const progressSchema = new Schema({
  userId: { type: String, required: true },
  courseId: { type: Schema.Types.ObjectId, required: true },
  lessonId: { type: Schema.Types.ObjectId, required: true },
  progressSeconds: { type: Number, default: 0 },
  completedAt: { type: Date, default: null },
  updatedAt: { type: Date, default: Date.now }
}, { versionKey: false, collection: "lesson_progress" });
progressSchema.index({ userId: 1, courseId: 1, lessonId: 1 }, { unique: true });
progressSchema.index({ userId: 1, courseId: 1, updatedAt: -1 });

const assignmentSchema = new Schema({
  courseId: { type: Schema.Types.ObjectId, required: true, index: true },
  instructorId: { type: String, required: true, index: true },
  title: { type: String, required: true, maxlength: 180 },
  instructions: { type: String, required: true, maxlength: 20_000 },
  dueAt: { type: Date, default: null }
}, { timestamps: true, collection: "assignments" });
assignmentSchema.index({ courseId: 1, dueAt: 1, _id: 1 });

const submissionSchema = new Schema({
  assignmentId: { type: Schema.Types.ObjectId, required: true },
  courseId: { type: Schema.Types.ObjectId, required: true },
  userId: { type: String, required: true },
  content: { type: String, required: true, maxlength: 50_000 },
  status: { type: String, enum: ["submitted", "graded"], default: "submitted" },
  submittedAt: { type: Date, default: Date.now }
}, { timestamps: true, collection: "submissions" });
submissionSchema.index({ assignmentId: 1, status: 1, createdAt: -1 });
submissionSchema.index({ userId: 1, createdAt: -1 });

const dashboardSchema = new Schema({
  userId: { type: String, required: true, unique: true },
  enrolledCourseCount: { type: Number, default: 0 },
  completedLessonCount: { type: Number, default: 0 },
  refreshedAt: { type: Date, default: Date.now }
}, { collection: "dashboard_summaries" });
dashboardSchema.index({ userId: 1 }, { unique: true });

const gradeSchema = new Schema({
  submissionId: { type: Schema.Types.ObjectId, required: true, unique: true },
  assignmentId: { type: Schema.Types.ObjectId, required: true, index: true },
  userId: { type: String, required: true, index: true },
  instructorId: { type: String, required: true, index: true },
  score: { type: Number, required: true, min: 0, max: 100 },
  feedback: { type: String, default: "", maxlength: 10_000 },
  publishedAt: { type: Date, default: null }
}, { timestamps: true, collection: "grades" });
gradeSchema.index({ instructorId: 1, createdAt: -1, _id: -1 });

const certificateSchema = new Schema({
  certificateNumber: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  courseId: { type: Schema.Types.ObjectId, required: true },
  issuedAt: { type: Date, default: Date.now },
  revokedAt: { type: Date, default: null }
}, { timestamps: true, collection: "certificates" });
certificateSchema.index({ userId: 1, issuedAt: -1, _id: -1 });
certificateSchema.index({ userId: 1, courseId: 1 }, { unique: true });

const reviewSchema = new Schema({
  courseId: { type: Schema.Types.ObjectId, required: true },
  userId: { type: String, required: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  text: { type: String, default: "", maxlength: 5_000 }
}, { timestamps: true, collection: "reviews" });
reviewSchema.index({ courseId: 1, userId: 1 }, { unique: true });
reviewSchema.index({ courseId: 1, createdAt: -1, _id: -1 });

const directMessageSchema = new Schema({
  threadId: { type: String, required: true },
  courseId: { type: Schema.Types.ObjectId, required: true, index: true },
  senderId: { type: String, required: true },
  recipientId: { type: String, required: true },
  body: { type: String, required: true, maxlength: 10_000 },
  readAt: { type: Date, default: null }
}, { timestamps: true, collection: "direct_messages" });
directMessageSchema.index({ threadId: 1, createdAt: -1, _id: -1 });
directMessageSchema.index({ recipientId: 1, readAt: 1, createdAt: -1 });

export const CourseModel = model("Course", courseSchema);
export const LessonModel = model("Lesson", lessonSchema);
export const EnrollmentModel = model("Enrollment", enrollmentSchema);
export const LessonProgressModel = model("LessonProgress", progressSchema);
export const AssignmentModel = model("Assignment", assignmentSchema);
export const SubmissionModel = model("Submission", submissionSchema);
export const DashboardSummaryModel = model("DashboardSummary", dashboardSchema);
export const GradeModel = model("Grade", gradeSchema);
export const CertificateModel = model("Certificate", certificateSchema);
export const ReviewModel = model("Review", reviewSchema);
export const DirectMessageModel = model("DirectMessage", directMessageSchema);
