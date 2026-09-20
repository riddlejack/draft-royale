import express from "express";
import type { SocialService } from "../social/service.js";
import { AccountError, type AccountService } from "./service.js";

export function createAccountRouter(accounts: AccountService, social: SocialService): express.Router {
  const router = express.Router();
  const attempts = new Map<string, { at: number; count: number }>();
  router.use("/api/accounts", (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "POST") {
      const time = Date.now();
      if (attempts.size > 2000) for (const [key, bucket] of attempts) if (time - bucket.at > 600_000) attempts.delete(key);
      const key = request.ip ?? "local";
      const bucket = attempts.get(key);
      if (!bucket || time - bucket.at > 600_000) attempts.set(key, { at: time, count: 1 });
      else if (++bucket.count > 40) { response.status(429).json({ error: "Too many sign-in attempts. Try again in ten minutes." }); return; }
    }
    next();
  });
  router.get("/api/accounts", (_request, response) => response.json({ players: accounts.list().map(({ displayName, tag }) => ({ displayName, tag })) }));
  router.post("/api/accounts/login", (request, response) => response.json(accounts.login(request.body)));
  router.post("/api/accounts/register", (request, response) => response.status(201).json(accounts.register(request.body)));
  router.get("/api/accounts/session", (request, response) => {
    const auth = social.authenticate(request.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "");
    response.json({ account: accounts.forProfile(auth.profile.id) });
  });
  router.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (error instanceof AccountError) { response.status(error.status).json({ error: error.message }); return; }
    next(error);
  });
  return router;
}
