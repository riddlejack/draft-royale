import express, { type RequestHandler, type Router } from "express";
import { CollectionImportError, type CollectionImportService } from "./collection-import.js";

export const createCollectionImportRouter = (service: CollectionImportService): Router => {
  const router = express.Router();
  const buckets = new Map<string, { count: number; resetsAt: number }>();
  const rateLimit: RequestHandler = (request, response, next) => {
    const timestamp = Date.now();
    if (buckets.size > 1_024) for (const [key, bucket] of buckets) if (bucket.resetsAt <= timestamp) buckets.delete(key);
    const key = request.ip ?? "unknown";
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetsAt <= timestamp) {
      bucket = { count: 0, resetsAt: timestamp + 60_000 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > 6) {
      response.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetsAt - timestamp) / 1_000))));
      response.status(429).json({ error: "Too many collection imports. Try again shortly.", code: "RATE_LIMITED" });
      return;
    }
    next();
  };

  router.post("/api/arena/collection/import", rateLimit, async (request, response, next) => {
    try {
      const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? request.body as Record<string, unknown>
        : {};
      response.json(await service.importPlayer(body.tag));
    } catch (error) { next(error); }
  });

  router.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (error instanceof CollectionImportError) {
      response.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    next(error);
  });
  return router;
};
