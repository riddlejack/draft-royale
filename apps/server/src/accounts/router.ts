import { createHash } from "node:crypto";
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
  const attempts = new Map<string, { resetsAt: number; count: number }>();
  router.use("/api/accounts", (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  const rateLimit = (scope: string, maximum: number, windowMs: number, keyBy: "ip" | "username" | "bearer" = "ip"): express.RequestHandler => (request, response, next) => {
    const timestamp = Date.now();
    if (attempts.size > 5_000) for (const [key, bucket] of attempts) if (bucket.resetsAt <= timestamp) attempts.delete(key);
    const input = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
    const suffix = keyBy === "username" && typeof input.username === "string"
      ? input.username.trim().toLowerCase().slice(0, 64)
      : keyBy === "bearer" ? createHash("sha256").update(bearer(request.header("authorization"))).digest("hex").slice(0, 24) : "";
    const key = `${scope}:${request.ip ?? "local"}:${suffix}`;
    let bucket = attempts.get(key);
    if (!bucket || bucket.resetsAt <= timestamp) {
      bucket = { count: 0, resetsAt: timestamp + windowMs };
      attempts.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maximum) {
      response.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetsAt - timestamp) / 1_000))));
      response.status(429).json({ error: "Too many attempts. Try again later.", code: "RATE_LIMITED" });
      return;
    }
    next();
  };
  const tunnelBudget = rateLimit("account-global", 300, 10 * 60_000);
  const credentialBudget = rateLimit("account-credential", 12, 10 * 60_000, "username");
  const registrationBudget = rateLimit("account-registration", 60, 60 * 60_000);
  const providerBudget = rateLimit("account-provider", 120, 10 * 60_000);
  const mutationBudget = rateLimit("account-authenticated", 600, 10 * 60_000, "bearer");
  const reauthenticationBudget = rateLimit("account-reauthentication", 12, 10 * 60_000, "bearer");

  const auth = (request: express.Request) => {
    const token = bearer(request.header("authorization"));
    const authenticated = social.authenticate(token);
    const account = accounts.forProfile(authenticated.profile.id);
    if (!account) throw new AccountError(401, "A signed-in Draft Royale account is required.", "ACCOUNT_REQUIRED");
    accounts.touchSession(token);
    return { ...authenticated, token, account };
  };

  router.get("/api/accounts/providers", (_request, response) => response.json(accounts.providerConfig()));
  router.post("/api/accounts/google/challenge", providerBudget, (request, response) => {
    const challenge = accounts.createGoogleChallenge();
    response.cookie(googleStateCookie, challenge.state, {
      httpOnly: true, sameSite: "lax", secure: secureRequest(request), maxAge: 10 * 60 * 1_000,
      path: "/api/accounts/google",
    });
    response.json(challenge);
  });
  router.post("/api/accounts/google", providerBudget, async (request, response, next) => {
    try {
      const state = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>).state : undefined;
      const cookie = cookieValue(request.header("cookie"), googleStateCookie);
      if (typeof state !== "string" || !cookie || cookie !== state) throw new AccountError(400, "Google sign-in could not confirm this browser. Try again.", "GOOGLE_STATE_MISMATCH");
      const action = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>).action : undefined;
      const profileId = action === "link" ? auth(request).profile.id : undefined;
      const result = await accounts.googleLogin(request.body, profileId);
      response.clearCookie(googleStateCookie, { httpOnly: true, sameSite: "lax", secure: secureRequest(request), path: "/api/accounts/google" });
      response.status(profileId ? 200 : 201).json(result);
    } catch (error) {
      response.clearCookie(googleStateCookie, { httpOnly: true, sameSite: "lax", secure: secureRequest(request), path: "/api/accounts/google" });
      next(error);
    }
  });
  router.post("/api/accounts/login", tunnelBudget, credentialBudget, (request, response) => response.json(accounts.login(request.body)));
  router.post("/api/accounts/register", tunnelBudget, registrationBudget, (request, response) => response.status(201).json(accounts.register(request.body)));
  router.post("/api/accounts/recover", tunnelBudget, credentialBudget, (request, response) => response.json(accounts.recover(request.body)));
  router.post("/api/accounts/recovery/rotate", mutationBudget, reauthenticationBudget, (request, response) => {
    const user = auth(request);
    response.json(accounts.rotateRecovery(user.profile.id, request.body));
  });
  router.get("/api/accounts/session", (request, response) => {
    const user = auth(request);
    response.json(accounts.sessionFor(user.profile.id));
  });
  router.post("/api/accounts/logout", mutationBudget, (request, response) => {
    const result = accounts.logout(bearer(request.header("authorization")));
    response.json({ ok: true, ...result });
  });
  router.patch("/api/accounts/profile", mutationBudget, (request, response) => {
    const user = auth(request);
    const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
    response.json({ account: accounts.updateTag(user.profile.id, body.tag) });
  });
  router.put("/api/accounts/collection", mutationBudget, (request, response) => {
    const user = auth(request);
    const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
    response.json({ collection: accounts.saveCollection(user.profile.id, body.collection) });
  });
  router.post("/api/accounts/collection/import", mutationBudget, async (request, response, next) => {
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
