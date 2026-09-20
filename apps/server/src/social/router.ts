import { createHash } from "node:crypto";
import express, { type Request, type RequestHandler, type Router } from "express";
import type { AuthenticatedSocialProfile, SocialService } from "./service.js";
import { SocialError } from "./service.js";

const tokenFromHeader = (request: Request) => {
  const authorization = request.header("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new SocialError(401, "Bearer profile credentials are required", "UNAUTHORIZED");
  return match[1]?.trim() ?? "";
};

const asyncRoute = (handler: RequestHandler): RequestHandler => (request, response, next) => {
  Promise.resolve(handler(request, response, next)).catch(next);
};

type AuthRoute = (auth: AuthenticatedSocialProfile, request: Request, response: express.Response) => unknown;

export const createSocialRouter = (service: SocialService): Router => {
  const router = express.Router();
  const rateBuckets = new Map<string, { count: number; resetsAt: number }>();
  const rateLimit: RequestHandler = (request, response, next) => {
    const timestamp = Date.now();
    if (rateBuckets.size > 2_048) {
      for (const [key, bucket] of rateBuckets) if (bucket.resetsAt <= timestamp) rateBuckets.delete(key);
      while (rateBuckets.size > 4_096) rateBuckets.delete(rateBuckets.keys().next().value as string);
    }
    const bearer = request.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const keys = [`ip:${request.ip}`, ...(bearer ? [`auth:${createHash("sha256").update(bearer).digest("hex")}`] : [])];
    const limited = keys.some((key) => {
      let bucket = rateBuckets.get(key);
      if (!bucket || bucket.resetsAt <= timestamp) {
        bucket = { count: 0, resetsAt: timestamp + 10_000 };
        rateBuckets.set(key, bucket);
      }
      bucket.count += 1;
      return bucket.count > 60;
    });
    if (limited) {
      response.status(429).json({ error: "Too many social requests", code: "RATE_LIMITED" });
      return;
    }
    next();
  };
  const authenticated = (handler: AuthRoute): RequestHandler => asyncRoute((request, response) => {
    const auth = service.authenticate(tokenFromHeader(request));
    return handler(auth, request, response);
  });

  router.use("/api/social", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Vary", "Authorization");
    next();
  }, rateLimit);

  router.post("/api/social/profiles", asyncRoute((request, response) => {
    const result = service.createProfile(request.body ?? {});
    const { created, ...payload } = result;
    response.status(created ? 201 : 200).json(payload);
  }));
  router.get("/api/social/state", authenticated((auth, _request, response) => response.json({ state: service.getState(auth) })));
  router.patch("/api/social/profile", authenticated((auth, request, response) => response.json({ state: service.updateProfile(auth, request.body ?? {}) })));

  router.post("/api/social/friend-links", authenticated((auth, request, response) => response.status(201).json({ friendLink: service.createFriendLink(auth, request.body ?? {}) })));
  router.post("/api/social/friend-links/accept", authenticated((auth, request, response) => response.json(service.acceptFriendLink(auth, request.body ?? {}))));
  router.post("/api/social/friends/:id/remove", authenticated((auth, request, response) => response.json({ state: service.removeFriend(auth, request.params.id, request.body ?? {}) })));

  router.post("/api/social/invites", authenticated((auth, request, response) => response.status(201).json(service.createInvite(auth, request.body ?? {}))));
  router.post("/api/social/invites/:id/accept", authenticated((auth, request, response) => response.json(service.acceptInvite(auth, request.params.id, request.body ?? {}))));
  router.post("/api/social/invites/:id/decline", authenticated((auth, request, response) => response.json(service.declineInvite(auth, request.params.id, request.body ?? {}))));
  router.post("/api/social/invites/:id/cancel", authenticated((auth, request, response) => response.json(service.cancelInvite(auth, request.params.id, request.body ?? {}))));
  router.get("/api/social/invites/:id/session", authenticated((auth, request, response) => response.json(service.getInviteSession(auth, request.params.id))));

  router.use((error: unknown, _request: Request, response: express.Response, next: express.NextFunction) => {
    if (error instanceof SocialError) {
      response.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    next(error);
  });

  return router;
};
