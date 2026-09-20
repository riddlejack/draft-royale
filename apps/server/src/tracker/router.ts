import { createHash } from "node:crypto";
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from "express";
import type { AuthenticatedSocialProfile, SocialService } from "../social/service.js";
import { SocialError } from "../social/service.js";
import type { TrackerService } from "./service.js";
import { TrackerError } from "./service.js";

const bearerToken = (request: Request) => {
  const match = request.header("authorization")?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]?.trim()) throw new TrackerError(401, "Sign in to view game history", "UNAUTHORIZED");
  return match[1].trim();
};

const visibleProfiles = (auth: AuthenticatedSocialProfile, social: SocialService) => {
  const socialState = social.getState(auth);
  return new Set([auth.profile.id, ...socialState.friends.map((friend) => friend.id)]);
};

const queryText = (value: unknown) => typeof value === "string" && value.length <= 100 ? value : undefined;

export const createTrackerRouter = (tracker: TrackerService, social: SocialService): Router => {
  const router = express.Router();
  const rateBuckets = new Map<string, { count: number; resetsAt: number }>();
  const rateLimit: RequestHandler = (request, response, next) => {
    const timestamp = Date.now();
    if (rateBuckets.size > 2_048) for (const [key, bucket] of rateBuckets) if (bucket.resetsAt <= timestamp) rateBuckets.delete(key);
    const bearer = request.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const key = bearer ? `auth:${createHash("sha256").update(bearer).digest("hex")}` : `ip:${request.ip}`;
    let bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetsAt <= timestamp) {
      bucket = { count: 0, resetsAt: timestamp + 10_000 };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > 100) {
      response.status(429).json({ error: "Too many tracker requests", code: "RATE_LIMITED" });
      return;
    }
    next();
  };
  const authenticated = (handler: (auth: AuthenticatedSocialProfile, scope: ReadonlySet<string>, request: Request, response: Response) => unknown): RequestHandler =>
    (request, response, next) => {
      try {
        const auth = social.authenticate(bearerToken(request));
        Promise.resolve(handler(auth, visibleProfiles(auth, social), request, response)).catch(next);
      } catch (error) { next(error); }
    };

  router.use("/api/tracker", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Vary", "Authorization");
    next();
  }, rateLimit);

  router.get("/api/tracker/status", authenticated((_auth, _scope, _request, response) => response.json({ status: tracker.getStatus() })));
  router.get("/api/tracker/summary", authenticated((auth, scope, request, response) => response.json({ summary: tracker.getSummary({
    actorProfileId: auth.profile.id,
    visibleProfileIds: scope,
    filters: {
      playerTag: queryText(request.query.playerTag),
      opponentTag: queryText(request.query.opponentTag),
      relationship: queryText(request.query.relationship) as "all" | "versus" | "alongside" | undefined,
      mode: queryText(request.query.mode),
      dateFrom: queryText(request.query.dateFrom),
      dateTo: queryText(request.query.dateTo),
    },
  }) })));
  router.post("/api/tracker/sync", authenticated(async (auth, scope, request, response) =>
    response.status(202).json({ status: await tracker.requestSync(auth.profile.id, scope, request.body?.playerTag) })));
  router.post("/api/tracker/manual", authenticated((auth, scope, request, response) =>
    response.status(201).json(tracker.addManualResult(auth.profile.id, scope, request.body ?? {}))));
  router.post("/api/tracker/manual/:id/undo", authenticated((auth, scope, request, response) =>
    response.json(tracker.undoManualResult(auth.profile.id, scope, request.params.id, request.body ?? {}))));

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof TrackerError || error instanceof SocialError) {
      response.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    next(error);
  });
  return router;
};
