import { createHash } from "node:crypto";
import express, { type Request, type RequestHandler, type Router } from "express";
import { ArenaError, type ArenaService } from "./service.js";

const maxBodyBytes = 64 * 1024;

const tokenFromHeader = (request: Request) => {
  const authorization = request.header("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ArenaError(401, "Bearer room credentials are required", "UNAUTHORIZED");
  return match[1]?.trim() ?? "";
};

const requestGuard: RequestHandler = (request, response, next) => {
  const contentLength = Number(request.header("content-length") ?? 0);
  const parsedBytes = request.body === undefined ? 0 : Buffer.byteLength(JSON.stringify(request.body));
  if ((Number.isFinite(contentLength) && contentLength > maxBodyBytes) || parsedBytes > maxBodyBytes) {
    response.status(413).json({ error: "Request body is too large", code: "BODY_TOO_LARGE" });
    return;
  }
  next();
};

const asyncRoute = (handler: RequestHandler): RequestHandler => (request, response, next) => {
  Promise.resolve(handler(request, response, next)).catch(next);
};

export const createArenaRouter = (service: ArenaService): Router => {
  const router = express.Router();
  const rateBuckets = new Map<string, { count: number; resetsAt: number }>();
  const rateLimit: RequestHandler = (request, response, next) => {
    const timestamp = Date.now();
    if (rateBuckets.size > 2_048) {
      for (const [key, bucket] of rateBuckets) if (bucket.resetsAt <= timestamp) rateBuckets.delete(key);
      while (rateBuckets.size > 4_096) rateBuckets.delete(rateBuckets.keys().next().value as string);
    }
    const bearer = request.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const keys = [
      `ip:${request.ip}`,
      ...(bearer ? [`auth:${createHash("sha256").update(bearer).digest("hex")}`] : []),
    ];
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
      response.status(429).json({ error: "Too many arena requests", code: "RATE_LIMITED" });
      return;
    }
    next();
  };

  router.use("/api/arena", requestGuard, rateLimit);

  router.get("/api/arena/catalog", (_request, response) => response.json(service.catalog));
  router.post("/api/arena/rooms", (request, response) => response.status(201).json(service.createRoom(request.body ?? {})));
  router.post("/api/arena/join", (request, response) => response.status(201).json(service.joinRoom(request.body ?? {})));
  router.get("/api/arena/rooms/:id/catalog", (request, response) => response.json(service.getRoomCatalog(request.params.id, tokenFromHeader(request))));
  router.get("/api/arena/rooms/:id", (request, response) => response.json(service.getView(request.params.id, tokenFromHeader(request))));
  router.post("/api/arena/rooms/:id/ready", (request, response) => response.json(service.setReady(request.params.id, tokenFromHeader(request), request.body ?? {})));
  router.post("/api/arena/rooms/:id/loaded", (request, response) => response.json(service.setLoaded(request.params.id, tokenFromHeader(request), request.body ?? {})));
  router.post("/api/arena/rooms/:id/pick", (request, response) => response.json(service.pick(request.params.id, tokenFromHeader(request), request.body ?? {})));
  router.post("/api/arena/rooms/:id/collection", (request, response) => response.json(service.setCollection(request.params.id, tokenFromHeader(request), request.body ?? {})));
  router.post("/api/arena/rooms/:id/settings", (request, response) => response.json(service.setSettings(request.params.id, tokenFromHeader(request), request.body ?? {})));
  router.post("/api/arena/rooms/:id/rematch", (request, response) => response.json(service.rematch(request.params.id, tokenFromHeader(request), request.body ?? {})));

  router.get("/api/arena/rooms/:id/events", asyncRoute((request, response) => {
    const token = tokenFromHeader(request);
    service.getView(String(request.params.id), token);
    response.status(200);
    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref?.();
    let unsubscribe = () => {};
    try {
      unsubscribe = service.subscribe(
        String(request.params.id),
        token,
        (view) => response.write(`event: room\ndata: ${JSON.stringify(view)}\n\n`),
        () => response.end(),
      );
    } catch (error) {
      clearInterval(heartbeat);
      throw error;
    }
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }));

  router.use((error: unknown, _request: Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof ArenaError) {
      response.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      return;
    }
    response.status(500).json({ error: "Arena request failed", code: "INTERNAL_ERROR" });
  });
  return router;
};
