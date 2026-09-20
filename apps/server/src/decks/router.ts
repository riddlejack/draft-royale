import express, { type RequestHandler } from "express";
import type { SocialService } from "../social/service.js";
import { DeckError, type DeckService } from "./service.js";

export function createDeckRouter(service: DeckService, social: SocialService, seeds: () => unknown): express.Router {
  const router = express.Router();
  const buckets = new Map<string, { at: number; count: number }>();
  const guard: RequestHandler = (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    const time = Date.now();
    if (buckets.size > 2000) for (const [key, bucket] of buckets) if (time - bucket.at > 60000) buckets.delete(key);
    const key = request.ip ?? "local";
    const bucket = buckets.get(key);
    if (!bucket || time - bucket.at > 60000) buckets.set(key, { at: time, count: 1 });
    else if (++bucket.count > 240) { response.status(429).json({ error: "Too many library requests. Try again shortly." }); return; }
    next();
  };
  const auth = (header?: string) => social.authenticate(header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "");
  router.use("/api/decks", guard);
  router.get("/api/decks/seeds", (_request, response) => response.json(seeds()));
  router.get("/api/decks/community", (_request, response) => response.json({ decks: service.list() }));
  router.get("/api/decks/mine", (request, response) => response.json({ decks: service.list(auth(request.header("authorization")).profile.id) }));
  router.post("/api/decks", (request, response) => {
    const user = auth(request.header("authorization"));
    response.status(201).json({ deck: service.save(user.profile.id, user.profile.display_name, request.body) });
  });
  router.delete("/api/decks/:id", (request, response) => { service.remove(auth(request.header("authorization")).profile.id, request.params.id); response.json({ ok: true }); });
  router.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (error instanceof DeckError) { response.status(error.status).json({ error: error.message }); return; }
    next(error);
  });
  return router;
}
