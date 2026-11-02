import { createHash, randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "@lumen/errors";
import { verifyInternalIdentity } from "@lumen/internal-identity";
import type { EventEnvelope, InternalIdentity } from "@lumen/types";
import { eventJobOptions } from "@lumen/queue-helpers";
import { CertificateModel, DirectMessageModel, GradeModel, ReviewModel } from "./models.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import {
  AssignmentModel, CourseModel, DashboardSummaryModel, EnrollmentModel, LessonModel,
  LessonProgressModel, SubmissionModel
} from "./models.js";

interface ProgressWrite {
  userId: string;
  courseId: string;
  lessonId: string;
  progressSeconds: number;
  completed: boolean;
}

interface LearningDependencies {
  internalIdentitySecret: string;
  events: Queue<EventEnvelope>;
  progressQueue: Queue<ProgressWrite>;
  redis: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, expiryMode: "EX", ttlSeconds: number): Promise<unknown>;
    incr(key: string): Promise<number>;
    del(key: string): Promise<number>;
  };
}

const courseInput = z.object({
  title: z.string().trim().min(1).max(180),
  description: z.string().min(1).max(20_000),
  category: z.string().trim().min(1).max(80),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([])
});
const lessonInput = z.object({
  title: z.string().trim().min(1).max(180),
  content: z.string().min(1).max(100_000),
  order: z.number().int().min(0),
  durationSeconds: z.number().int().min(0).max(86_400).default(0)
});
const assignmentInput = z.object({
  courseId: z.string().regex(/^[0-9a-f]{24}$/i),
  title: z.string().trim().min(1).max(180),
  instructions: z.string().min(1).max(20_000),
  dueAt: z.iso.datetime().nullable().optional()
});
const submissionInput = z.object({
  assignmentId: z.string().regex(/^[0-9a-f]{24}$/i),
  content: z.string().min(1).max(50_000)
});
const gradingInput = z.object({
  grades: z.array(z.object({
    submissionId: z.string().regex(/^[0-9a-f]{24}$/i),
    score: z.number().min(0).max(100),
    feedback: z.string().max(10_000).default("")
  })).min(1).max(100)
});
const reviewInput = z.object({
  rating: z.number().int().min(1).max(5),
  text: z.string().max(5_000).default("")
});
const messageInput = z.object({
  courseId: z.string().regex(/^[0-9a-f]{24}$/i),
  recipientId: z.string().min(1).max(100),
  body: z.string().trim().min(1).max(10_000)
});
const progressInput = z.object({
  courseId: z.string().regex(/^[0-9a-f]{24}$/i),
  lessonId: z.string().regex(/^[0-9a-f]{24}$/i),
  progressSeconds: z.number().int().min(0).max(604_800),
  completed: z.boolean().default(false)
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError("Invalid request", 400, "VALIDATION_ERROR");
  return result.data;
}

function identity(request: FastifyRequest, secret: string): InternalIdentity {
  const value = request.headers["x-lumen-identity"];
  const result = verifyInternalIdentity(Array.isArray(value) ? value[0] : value, secret);
  if (!result) throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  return result;
}

function requireRole(user: InternalIdentity, roles: string[]): void {
  if (!roles.includes(user.role)) throw new AppError("Insufficient permissions", 403, "FORBIDDEN");
}

async function publish<T extends Record<string, unknown>>(
  queue: Queue<EventEnvelope>,
  type: string,
  payload: T
): Promise<void> {
  const event: EventEnvelope = {
    eventId: randomUUID(),
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    producer: "learning-service",
    payload
  };
  await queue.add(type, event, eventJobOptions(event));
}

async function invalidateCourseCaches(redis: LearningDependencies["redis"], courseId: string): Promise<void> {
  await Promise.all([redis.incr("courses:catalog:version"), redis.del(`courses:detail:${courseId}`)]);
}

export function registerLearningRoutes(app: FastifyInstance, dependencies: LearningDependencies): void {
  app.get("/api/learning-service/courses", async (request) => {
    const query = request.query as { cursor?: string; limit?: string; category?: string; search?: string };
    const catalogKey = `courses:catalog:${await dependencies.redis.get("courses:catalog:version") ?? "0"}:${createHash("sha256").update(JSON.stringify(query)).digest("hex")}`;
    const cached = await dependencies.redis.get(catalogKey);
    if (cached) return JSON.parse(cached) as Record<string, unknown>;
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "20", 10) || 20, 1), 50);
    const cursor = decodeCursor(query.cursor);
    const filter: Record<string, unknown> = { published: true };
    if (query.category) filter.category = query.category;
    if (query.search?.trim()) {
      const escaped = query.search.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { title: { $regex: escaped, $options: "i" } },
        { tags: { $regex: escaped, $options: "i" } }
      ];
    }
    if (cursor) {
      filter.$and = [
        { $or: [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor.id } }] }
      ];
    }
    const rows = await CourseModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .select("_id title description category tags enrollmentCount averageRating reviewCount lessonCount createdAt")
      .lean();
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const result = {
      items,
      nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last._id }) : null
    };
    await dependencies.redis.set(catalogKey, JSON.stringify(result), "EX", 60);
    return result;
  });

  app.get("/api/learning-service/courses/:courseId", async (request) => {
    const { courseId } = request.params as { courseId: string };
    if (!/^[0-9a-f]{24}$/i.test(courseId)) throw new AppError("Course not found", 404, "COURSE_NOT_FOUND");
    const cached = await dependencies.redis.get(`courses:detail:${courseId}`);
    if (cached) return JSON.parse(cached) as Record<string, unknown>;
    const [course, lessons] = await Promise.all([
      CourseModel.findOne({ _id: courseId, published: true })
        .select("_id instructorId title description category tags enrollmentCount averageRating reviewCount lessonCount createdAt")
        .lean(),
      LessonModel.find({ courseId }).sort({ order: 1, _id: 1 }).select("_id title order durationSeconds").lean()
    ]);
    if (!course) throw new AppError("Course not found", 404, "COURSE_NOT_FOUND");
    const result = { course, lessons };
    await dependencies.redis.set(`courses:detail:${courseId}`, JSON.stringify(result), "EX", 60);
    return result;
  });

  app.post("/api/learning-service/courses", async (request, reply) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    requireRole(user, ["instructor", "admin"]);
    const input = parse(courseInput, request.body);
    const course = await CourseModel.create({ ...input, instructorId: user.userId });
    return reply.code(201).send({ course });
  });

  app.get("/api/learning-service/instructor/courses", async (request) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    requireRole(user, ["instructor", "admin"]);
    const query = request.query as { cursor?: string; limit?: string };
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "20", 10) || 20, 1), 50);
    const cursor = decodeCursor(query.cursor);
    const filter: Record<string, unknown> = { instructorId: user.userId };
    if (cursor) filter.$or = [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor.id } }
    ];
    const rows = await CourseModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last._id }) : null
    };
  });

  app.post("/api/learning-service/courses/:courseId/publish", async (request) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    requireRole(user, ["instructor", "admin"]);
    const { courseId } = request.params as { courseId: string };
    const ownerFilter = user.role === "admin" ? { _id: courseId } : { _id: courseId, instructorId: user.userId };
    const course = await CourseModel.findOneAndUpdate(ownerFilter, { $set: { published: true } }, { new: true })
      .select("_id title published")
      .lean();
    if (!course) throw new AppError("Course not found", 404, "COURSE_NOT_FOUND");
    await invalidateCourseCaches(dependencies.redis, courseId);
    return { course };
  });

  app.post("/api/learning-service/courses/:courseId/lessons", async (request, reply) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    requireRole(user, ["instructor", "admin"]);
    const { courseId } = request.params as { courseId: string };
    const filter = user.role === "admin" ? { _id: courseId } : { _id: courseId, instructorId: user.userId };
    const course = await CourseModel.findOne(filter).select("_id").lean();
    if (!course) throw new AppError("Course not found", 404, "COURSE_NOT_FOUND");
    const input = parse(lessonInput, request.body);
    const lesson = await LessonModel.create({ ...input, courseId });
    await CourseModel.updateOne({ _id: courseId }, { $inc: { lessonCount: 1 } });
    await invalidateCourseCaches(dependencies.redis, courseId);
    return reply.code(201).send({ lesson: { id: String(lesson._id), title: lesson.title, order: lesson.order } });
  });

  app.post("/api/learning-service/enrollments", async (request, reply) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    requireRole(user, ["student", "instructor", "admin"]);
    const input = z.object({ courseId: z.string().regex(/^[0-9a-f]{24}$/i) }).parse(request.body);
    const course = await CourseModel.findOne({ _id: input.courseId, published: true }).select("_id instructorId").lean();
    if (!course) throw new AppError("Course not found", 404, "COURSE_NOT_FOUND");
    const result = await EnrollmentModel.updateOne(
      { userId: user.userId, courseId: course._id },
      { $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    if (result.upsertedCount > 0) {
      await CourseModel.updateOne({ _id: course._id }, { $inc: { enrollmentCount: 1 } });
      await DashboardSummaryModel.updateOne(
        { userId: user.userId },
        { $inc: { enrolledCourseCount: 1 }, $set: { refreshedAt: new Date() }, $setOnInsert: { completedLessonCount: 0 } },
        { upsert: true }
      );
      await dependencies.redis.del(`dashboard:student:${user.userId}`);
      await publish(dependencies.events, "enrollment.created", { userId: user.userId, courseId: String(course._id) });
    }
    return reply.code(result.upsertedCount > 0 ? 201 : 200).send({ courseId: String(course._id), enrolled: true });
  });

  app.get("/api/learning-service/my/courses", async (request) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    const query = request.query as { cursor?: string; limit?: string };
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "20", 10) || 20, 1), 50);
    const cursor = decodeCursor(query.cursor);
    const filter: Record<string, unknown> = { userId: user.userId };
    if (cursor) filter.$or = [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor.id } }
    ];
    const enrollments = await EnrollmentModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1)
      .select("courseId createdAt")
      .lean();
    const page = enrollments.slice(0, limit);
    const courses = await CourseModel.find({ _id: { $in: page.map((item) => item.courseId) } })
      .select("_id title category lessonCount")
      .lean();
    const byId = new Map(courses.map((course) => [String(course._id), course]));
    const items = page.map((item) => ({ enrollment: item, course: byId.get(String(item.courseId)) ?? null }));
    const last = page.at(-1);
    return {
      items,
      nextCursor: enrollments.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last._id }) : null
    };
  });

  app.get("/api/learning-service/student/dashboard", async (request) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    const cacheKey = `dashboard:student:${user.userId}`;
    const cached = await dependencies.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as Record<string, unknown>;
    const summary = await DashboardSummaryModel.findOne({ userId: user.userId })
      .select("enrolledCourseCount completedLessonCount refreshedAt")
      .lean();
    const value = {
      enrolledCourseCount: summary?.enrolledCourseCount ?? 0,
      completedLessonCount: summary?.completedLessonCount ?? 0,
      refreshedAt: summary?.refreshedAt ?? new Date(0)
    };
    await dependencies.redis.set(cacheKey, JSON.stringify(value), "EX", 60);
    return value;
  });

  app.get("/api/learning-service/assignments", async (request) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    const query = request.query as { cursor?: string; limit?: string; courseId?: string };
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "20", 10) || 20, 1), 50);
    const cursor = decodeCursor(query.cursor);
    let courseIds: unknown[];
    if (user.role === "instructor" || user.role === "admin") {
      const courses = await CourseModel.find(user.role === "admin" ? {} : { instructorId: user.userId }).select("_id").lean();
      courseIds = courses.map((course) => course._id);
    } else {
      const enrollments = await EnrollmentModel.find({ userId: user.userId }).select("courseId").lean();
      courseIds = enrollments.map((enrollment) => enrollment.courseId);
    }
    const filter: Record<string, unknown> = { courseId: { $in: courseIds } };
    if (query.courseId) filter.courseId = query.courseId;
    if (cursor) filter.$or = [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor.id } }
    ];
    const rows = await AssignmentModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last._id }) : null
    };
  });

  app.post("/api/learning-service/assignments", async (request, reply) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    requireRole(user, ["instructor", "admin"]);
    const input = parse(assignmentInput, request.body);
    const course = await CourseModel.findOne({
      _id: input.courseId,
      ...(user.role === "admin" ? {} : { instructorId: user.userId })
    }).select("_id").lean();
    if (!course) throw new AppError("Course not found", 404, "COURSE_NOT_FOUND");
    const assignment = await AssignmentModel.create({
      ...input,
      courseId: course._id,
      instructorId: user.userId,
      ...(input.dueAt ? { dueAt: new Date(input.dueAt) } : {})
    });
    return reply.code(201).send({ assignment });
  });

  app.post("/api/learning-service/submissions", async (request, reply) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    const input = parse(submissionInput, request.body);
    const assignment = await AssignmentModel.findById(input.assignmentId).select("courseId").lean();
    if (!assignment || !await EnrollmentModel.exists({ userId: user.userId, courseId: assignment.courseId })) {
      throw new AppError("Assignment not found", 404, "ASSIGNMENT_NOT_FOUND");
    }
    const submission = await SubmissionModel.create({
      ...input,
      courseId: assignment.courseId,
      userId: user.userId
    });
    await publish(dependencies.events, "submission.created", {
      submissionId: String(submission._id),
      assignmentId: input.assignmentId,
      courseId: String(assignment.courseId),
      userId: user.userId
    });
    return reply.code(201).send({ submissionId: String(submission._id), status: submission.status });
  });

  app.get("/api/learning-service/instructor/courses/:courseId/students", async (request) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    requireRole(user, ["instructor", "admin"]);
    const { courseId } = request.params as { courseId: string };
    const owned = await CourseModel.exists({
      _id: courseId,
      ...(user.role === "admin" ? {} : { instructorId: user.userId })
    });
    if (!owned) throw new AppError("Course not found", 404, "COURSE_NOT_FOUND");
    const query = request.query as { cursor?: string; limit?: string };
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "20", 10) || 20, 1), 50);
    const cursor = decodeCursor(query.cursor);
    const filter: Record<string, unknown> = { courseId };
    if (cursor) filter.$or = [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor.id } }
    ];
    const rows = await EnrollmentModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(({ userId, createdAt }) => ({ userId, enrolledAt: createdAt })),
      nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last._id }) : null
    };
  });

  app.get("/api/learning-service/instructor/submissions", async (request) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    requireRole(user, ["instructor", "admin"]);
    const query = request.query as { cursor?: string; limit?: string };
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "20", 10) || 20, 1), 50);
    const cursor = decodeCursor(query.cursor);
    const match: Record<string, unknown> = {
      "assignment.instructorId": user.role === "admin" ? { $exists: true } : user.userId
    };
    if (cursor) match.$or = [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor.id } }
    ];
    const rows = await SubmissionModel.aggregate([
      { $lookup: { from: "assignments", localField: "assignmentId", foreignField: "_id", as: "assignment" } },
      { $unwind: "$assignment" },
      { $match: match },
      { $sort: { createdAt: -1, _id: -1 } },
      { $limit: limit + 1 },
      { $project: { assignmentId: 1, courseId: 1, userId: 1, content: 1, status: 1, submittedAt: 1, createdAt: 1 } }
    ]);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last._id }) : null
    };
  });

  app.post("/api/learning-service/grades/bulk", async (request, reply) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    requireRole(user, ["instructor", "admin"]);
    const input = parse(gradingInput, request.body);
    const ids = input.grades.map((grade) => grade.submissionId);
    const submissions = await SubmissionModel.find({ _id: { $in: ids } })
      .select("_id assignmentId userId")
      .lean();
    if (submissions.length !== input.grades.length) throw new AppError("One or more submissions were not found", 404, "SUBMISSION_NOT_FOUND");
    const assignmentIds = [...new Set(submissions.map((submission) => String(submission.assignmentId)))];
    const assignments = await AssignmentModel.find({
      _id: { $in: assignmentIds },
      ...(user.role === "admin" ? {} : { instructorId: user.userId })
    }).select("_id instructorId").lean();
    if (assignments.length !== assignmentIds.length) throw new AppError("Submission not found", 404, "SUBMISSION_NOT_FOUND");
    const assignmentById = new Map(assignments.map((assignment) => [String(assignment._id), assignment]));
    const submissionsById = new Map(submissions.map((submission) => [String(submission._id), submission]));
    const now = new Date();
    const ops = input.grades.map((grade) => {
      const submission = submissionsById.get(grade.submissionId)!;
      const assignment = assignmentById.get(String(submission.assignmentId))!;
      return {
        updateOne: {
          filter: { submissionId: submission._id },
          update: {
            $set: {
              assignmentId: submission.assignmentId,
              userId: submission.userId,
              instructorId: assignment.instructorId,
              score: grade.score,
              feedback: grade.feedback,
              publishedAt: now
            }
          },
          upsert: true
        }
      };
    });
    await GradeModel.bulkWrite(ops, { ordered: false });
    await SubmissionModel.bulkWrite(input.grades.map((grade) => ({
      updateOne: { filter: { _id: grade.submissionId }, update: { $set: { status: "graded" } } }
    })), { ordered: false });
    await publish(dependencies.events, "grade.published", {
      instructorId: user.userId,
      submissionIds: ids,
      publishedAt: now.toISOString()
    });
    return reply.send({ updated: input.grades.length });
  });

  app.get("/api/learning-service/certificates", async (request) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    const query = request.query as { cursor?: string; limit?: string };
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "20", 10) || 20, 1), 50);
    const cursor = decodeCursor(query.cursor);
    const filter: Record<string, unknown> = { userId: user.userId, revokedAt: null };
    if (cursor) filter.$or = [
      { issuedAt: { $lt: cursor.createdAt } },
      { issuedAt: cursor.createdAt, _id: { $lt: cursor.id } }
    ];
    const rows = await CertificateModel.find(filter).sort({ issuedAt: -1, _id: -1 }).limit(limit + 1).lean();
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.issuedAt, id: last._id }) : null
    };
  });

  app.post("/api/learning-service/certificates/issue", async (request, reply) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    requireRole(user, ["instructor", "admin"]);
    const input = z.object({ courseId: z.string().regex(/^[0-9a-f]{24}$/i), userId: z.string().min(1).max(100) }).parse(request.body);
    const course = await CourseModel.findOne({
      _id: input.courseId,
      ...(user.role === "admin" ? {} : { instructorId: user.userId })
    }).select("_id lessonCount").lean();
    if (!course || !await EnrollmentModel.exists({ userId: input.userId, courseId: course._id })) {
      throw new AppError("Eligible enrollment not found", 404, "ENROLLMENT_NOT_FOUND");
    }
    const completedCount = await LessonProgressModel.countDocuments({
      userId: input.userId,
      courseId: course._id,
      completedAt: { $ne: null }
    });
    if (completedCount < course.lessonCount) throw new AppError("Course requirements are not complete", 409, "COURSE_INCOMPLETE");
    const session = await CourseModel.db.startSession();
    let certificate: { certificateNumber: string; issuedAt: Date } | undefined;
    try {
      await session.withTransaction(async () => {
        const created = await CertificateModel.create([{
          certificateNumber: randomUUID(),
          userId: input.userId,
          courseId: course._id
        }], { session });
        certificate = {
          certificateNumber: created[0]!.certificateNumber,
          issuedAt: created[0]!.issuedAt
        };
      });
    } finally {
      await session.endSession();
    }
    if (!certificate) throw new AppError("Certificate could not be issued", 500, "CERTIFICATE_FAILED");
    await publish(dependencies.events, "certificate.issued", {
      userId: input.userId,
      courseId: String(course._id),
      certificateNumber: certificate.certificateNumber
    });
    return reply.code(201).send({ certificate });
  });

  app.get("/api/learning-service/courses/:courseId/reviews", async (request) => {
    const { courseId } = request.params as { courseId: string };
    if (!await CourseModel.exists({ _id: courseId, published: true })) {
      throw new AppError("Course not found", 404, "COURSE_NOT_FOUND");
    }
    const query = request.query as { cursor?: string; limit?: string };
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "20", 10) || 20, 1), 50);
    const cursor = decodeCursor(query.cursor);
    const filter: Record<string, unknown> = { courseId };
    if (cursor) filter.$or = [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor.id } }
    ];
    const rows = await ReviewModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1)
      .select("userId rating text createdAt")
      .lean();
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last._id }) : null
    };
  });

  app.post("/api/learning-service/courses/:courseId/reviews", async (request, reply) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    const { courseId } = request.params as { courseId: string };
    const input = parse(reviewInput, request.body);
    if (!await EnrollmentModel.exists({ userId: user.userId, courseId })) {
      throw new AppError("Enrollment required to review this course", 403, "ENROLLMENT_REQUIRED");
    }
    const session = await CourseModel.db.startSession();
    let created = false;
    try {
      await session.withTransaction(async () => {
        const previous = await ReviewModel.findOne({ courseId, userId: user.userId }).session(session).lean();
        const course = await CourseModel.findById(courseId).session(session).lean();
        if (!course) throw new AppError("Course not found", 404, "COURSE_NOT_FOUND");
        const count = course.reviewCount;
        const average = previous
          ? (course.averageRating * count - previous.rating + input.rating) / Math.max(count, 1)
          : (course.averageRating * count + input.rating) / (count + 1);
        await ReviewModel.findOneAndUpdate(
          { courseId, userId: user.userId },
          { $set: { rating: input.rating, text: input.text } },
          { upsert: true, new: true, session }
        );
        await CourseModel.updateOne(
          { _id: courseId },
          { $set: { averageRating: average }, ...(previous ? {} : { $inc: { reviewCount: 1 } }) },
          { session }
        );
        created = !previous;
      });
    } finally {
      await session.endSession();
    }
    if (created) await publish(dependencies.events, "review.created", { userId: user.userId, courseId });
    await invalidateCourseCaches(dependencies.redis, courseId);
    return reply.code(created ? 201 : 200).send({ saved: true });
  });

  app.get("/api/learning-service/messages/:threadId", async (request) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    const { threadId } = request.params as { threadId: string };
    const query = request.query as { cursor?: string; limit?: string };
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "30", 10) || 30, 1), 50);
    const cursor = decodeCursor(query.cursor);
    const filter: Record<string, unknown> = {
      threadId,
      $or: [{ senderId: user.userId }, { recipientId: user.userId }]
    };
    if (cursor) filter.$and = [
      { $or: [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor.id } }] }
    ];
    const rows = await DirectMessageModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last._id }) : null
    };
  });

  app.post("/api/learning-service/messages", async (request, reply) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    const input = parse(messageInput, request.body);
    if (input.recipientId === user.userId) throw new AppError("Cannot message yourself", 400, "INVALID_RECIPIENT");
    const course = await CourseModel.findById(input.courseId).select("instructorId").lean();
    if (!course) throw new AppError("Course not found", 404, "COURSE_NOT_FOUND");
    const senderEnrolled = await EnrollmentModel.exists({ userId: user.userId, courseId: input.courseId });
    const recipientEnrolled = await EnrollmentModel.exists({ userId: input.recipientId, courseId: input.courseId });
    const senderAllowed = user.role === "admin" || course.instructorId === user.userId || senderEnrolled;
    const recipientAllowed = course.instructorId === input.recipientId || recipientEnrolled;
    if (!senderAllowed || !recipientAllowed) throw new AppError("Message participants are not enrolled in this course", 403, "FORBIDDEN");
    const members = [user.userId, input.recipientId].sort();
    const threadId = createHash("sha256").update(`${input.courseId}:${members.join(":")}`).digest("hex");
    const message = await DirectMessageModel.create({
      threadId,
      courseId: input.courseId,
      senderId: user.userId,
      recipientId: input.recipientId,
      body: input.body
    });
    await publish(dependencies.events, "direct_message.created", {
      messageId: String(message._id),
      courseId: input.courseId,
      senderId: user.userId,
      recipientId: input.recipientId
    });
    return reply.code(201).send({ id: String(message._id), threadId, createdAt: message.createdAt });
  });

  app.post("/api/learning-service/progress", async (request, reply) => {
    const user = identity(request, dependencies.internalIdentitySecret);
    const input = parse(progressInput, request.body);
    const keyHeader = request.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new AppError("An Idempotency-Key header is required", 400, "IDEMPOTENCY_KEY_REQUIRED");
    }
    const enrolled = await EnrollmentModel.exists({ userId: user.userId, courseId: input.courseId });
    const lesson = await LessonModel.exists({ _id: input.lessonId, courseId: input.courseId });
    if (!enrolled || !lesson) throw new AppError("Lesson not found", 404, "LESSON_NOT_FOUND");
    const jobId = createHash("sha256").update(`${user.userId}:${input.courseId}:${input.lessonId}:${idempotencyKey}`).digest("hex");
    await dependencies.progressQueue.add("progress.write", {
      userId: user.userId,
      courseId: input.courseId,
      lessonId: input.lessonId,
      progressSeconds: input.progressSeconds,
      completed: input.completed
    }, { jobId, attempts: 5, backoff: { type: "exponential", delay: 500 } });
    return reply.code(202).send({ status: "accepted" });
  });
}

export async function processProgressWrite(
  write: ProgressWrite,
  eventQueue: Queue<EventEnvelope>,
  redis?: { del(key: string): Promise<number> }
): Promise<void> {
  const filter = { userId: write.userId, courseId: write.courseId, lessonId: write.lessonId };
  await LessonProgressModel.updateOne(filter, {
    $max: { progressSeconds: write.progressSeconds },
    $set: { updatedAt: new Date() },
    $setOnInsert: { completedAt: null }
  }, { upsert: true });
  if (!write.completed) return;
  const completedAt = new Date();
  const completed = await LessonProgressModel.updateOne(
    { ...filter, completedAt: null },
    { $set: { completedAt, updatedAt: completedAt } }
  );
  if (completed.modifiedCount === 0) return;
  await DashboardSummaryModel.updateOne(
    { userId: write.userId },
    { $inc: { completedLessonCount: 1 }, $set: { refreshedAt: completedAt }, $setOnInsert: { enrolledCourseCount: 0 } },
    { upsert: true }
  );
  await redis?.del(`dashboard:student:${write.userId}`);
  await publish(eventQueue, "lesson.completed", {
    userId: write.userId,
    courseId: write.courseId,
    lessonId: write.lessonId
  });
}
