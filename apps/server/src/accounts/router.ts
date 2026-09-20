import express from "express";
import type { CollectionImportService } from "../arena/collection-import.js";
import type { SocialService } from "../social/service.js";
import { AccountError, type AccountService } from "./service.js";

const googleStateCookie = "draft_royale_google_state";
const bearer = (header?: string) => header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
const cookieValue = (header: string | undefined, name: string) => {
  for (const part of header?.split(";") ?? []) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
};
const secureRequest = (request: express.Request) => request.secure || request.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https";

export function createAccountRouter(accounts: AccountService, social: SocialService, collectionImport: CollectionImportService): express.Router {
  const router = express.Router();
  const attempts = new Map<string, { at: number; count: number }>();
  router.use("/api/accounts", (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "POST") {
      const time = Date.now();
      if (attempts.size > 2_000) for (const [key, bucket] of attempts) if (time - bucket.at > 600_000) attempts.delete(key);
      const key = request.ip ?? "local";
      const bucket = attempts.get(key);
      if (!bucket || time - bucket.at > 600_000) attempts.set(key, { at: time, count: 1 });
      else if (++bucket.count > 60) { response.status(429).json({ error: "Too many account requests. Try again in ten minutes.", code: "RATE_LIMITED" }); return; }
    }
    next();
  });

  const auth = (request: express.Request) => {
    const token = bearer(request.header("authorization"));
    const authenticated = social.authenticate(token);
    const account = accounts.forProfile(authenticated.profile.id);
    if (!account) throw new AccountError(401, "A signed-in Draft Royale account is required.", "ACCOUNT_REQUIRED");
    accounts.touchSession(token);
    return { ...authenticated, token, account };
  };

  router.get("/api/accounts/providers", (_request, response) => response.json(accounts.providerConfig()));
  router.post("/api/accounts/google/challenge", (request, response) => {
    const challenge = accounts.createGoogleChallenge();
    response.cookie(googleStateCookie, challenge.state, {
      httpOnly: true, sameSite: "lax", secure: secureRequest(request), maxAge: 10 * 60 * 1_000,
      path: "/api/accounts/google",
    });
    response.json(challenge);
  });
  router.post("/api/accounts/google", async (request, response, next) => {
    try {
      const state = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>).state : undefined;
      const cookie = cookieValue(request.header("cookie"), googleStateCookie);
      if (typeof state !== "string" || !cookie || cookie !== state) throw new AccountError(400, "Google sign-in could not confirm this browser. Try again.", "GOOGLE_STATE_MISMATCH");
      const action = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>).action : undefined;
      const profileId = action === "link" ? auth(request).profile.id : undefined;
      const result = await accounts.googleLogin(request.body, profileId);
      response.clearCookie(googleStateCookie, { httpOnly: true, sameSite: "lax", secure: secureRequest(request), path: "/api/accounts/google" });
      response.status(profileId ? 200 : 201).json(result);
    } catch (error) { next(error); }
  });
  router.post("/api/accounts/login", (request, response) => response.json(accounts.login(request.body)));
  router.post("/api/accounts/register", (request, response) => response.status(201).json(accounts.register(request.body)));
  router.post("/api/accounts/recover", (request, response) => response.json(accounts.recover(request.body)));
  router.get("/api/accounts/session", (request, response) => {
    const user = auth(request);
    response.json(accounts.sessionFor(user.profile.id));
  });
  router.post("/api/accounts/logout", (request, response) => {
    const user = auth(request);
    accounts.logout(user.profile.id, user.token);
    response.json({ ok: true });
  });
  router.patch("/api/accounts/profile", (request, response) => {
    const user = auth(request);
    const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
    response.json({ account: accounts.updateTag(user.profile.id, body.tag) });
  });
  router.put("/api/accounts/collection", (request, response) => {
    const user = auth(request);
    const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
    response.json({ collection: accounts.saveCollection(user.profile.id, body.collection) });
  });
  router.post("/api/accounts/collection/import", async (request, response, next) => {
    try {
      const user = auth(request);
      if (!user.account.tag) throw new AccountError(409, "Add a Clash Royale tag before importing a collection.", "PLAYER_TAG_REQUIRED");
      const imported = await collectionImport.importPlayer(user.account.tag);
      const collection = accounts.saveCollection(user.profile.id, imported.collection);
      response.json({ ...imported, collection });
    } catch (error) { next(error); }
  });

  router.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (error instanceof AccountError) { response.status(error.status).json({ error: error.message, code: error.code }); return; }
    next(error);
  });
  return router;
}
