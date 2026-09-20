import { afterEach, describe, expect, it } from "vitest";
import { createHash, createHmac, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import type { ArenaCard } from "@draft-royale/shared";
import { createArenaApp } from "../arena/index.js";
import { repoRoot } from "../config.js";
import type { AccountService } from "./service.js";

const catalog = (JSON.parse(readFileSync(path.join(repoRoot, "data/catalog/arena-catalog.json"), "utf8")) as { cards: ArenaCard[] }).cards;
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach((close) => close()));
describe("remembered player accounts", () => {
  it("starts without a personal roster and keeps securely registered profiles stable across restarts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "draft-accounts-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const options = { catalog, catalogVersion: "test", databasePath: path.join(dir, "test.sqlite") };
    const app = createArenaApp(options);
    const accounts = app.locals.accountService as AccountService;
    expect(accounts.list()).toEqual([]);
    expect(() => accounts.register({ displayName: "NewFriend", tag: "#P0LYQ", password: "NewFriend" })).toThrow(/12–128/);
    const first = accounts.register({ displayName: "NewFriend", tag: "#P0LYQ", password: "correct horse battery" });
    expect(first.account.tag).toBe("#P0LYQ");
    expect(first.recoveryCode).toMatch(/^DR-(?:[A-F0-9]{4}-){5}[A-F0-9]{4}$/);
    expect(first.state.friends).toEqual([]);
    expect(() => accounts.login({ username: "NewFriend", password: "wrong password value" })).toThrow("incorrect");
    app.locals.arenaService.close();
    const restored = createArenaApp(options);
    cleanup.push(() => restored.locals.arenaService.close());
    const second = (restored.locals.accountService as AccountService).login({ username: "newfriend", password: "correct horse battery" });
    expect(second.credential.profileId).toBe(first.credential.profileId);
    expect(second.credential.token).not.toBe(first.credential.token);
    expect(second.state.friends).toHaveLength(0);
  });
  it("allows separate accounts to track the same public tag while keeping sessions and resources profile-scoped", async () => {
    const app = createArenaApp({ catalog, catalogVersion: "test", databasePath: ":memory:" });
    cleanup.push(() => app.locals.arenaService.close());
    const accounts = app.locals.accountService as AccountService;
    const first = accounts.register({ displayName: "NewFriend", tag: "#P0LYQ", password: "a secure local password" });
    const second = accounts.register({ displayName: "Someone", tag: "#P0LYQ", password: "another secure password" });
    expect(first.account.tag).toBe(second.account.tag);
    expect(first.account.profileId).not.toBe(second.account.profileId);
    expect(accounts.login({ username: "NewFriend", password: "a secure local password" }).credential.profileId).toBe(first.account.profileId);
    const firstBearer = { Authorization: `Bearer ${first.credential.token}` };
    const secondBearer = { Authorization: `Bearer ${second.credential.token}` };
    await request(app).post("/api/decks").set(firstBearer).send({
      commandId: "private-first", deck: { id: "first", name: "First private", mode: "classic", cards: ["hog-rider", "musketeer", "ice-golem", "skeletons", "ice-spirit", "cannon", "fireball", "the-log"] },
    }).expect(201);
    expect((await request(app).get("/api/decks/mine").set(firstBearer).expect(200)).body.decks).toHaveLength(1);
    expect((await request(app).get("/api/decks/mine").set(secondBearer).expect(200)).body.decks).toHaveLength(0);
    await request(app).post("/api/accounts/logout").set(firstBearer).expect(200, { ok: true, alreadyRevoked: false });
    await request(app).post("/api/accounts/logout").set(firstBearer).expect(200, { ok: true, alreadyRevoked: true });
    await request(app).get("/api/accounts/session").set(firstBearer).expect(401);
    await request(app).get("/api/accounts/session").set(secondBearer).expect(200);
  });
  it("does not expose the account roster over HTTP", async () => {
    const app = createArenaApp({ catalog, catalogVersion: "test", databasePath: ":memory:" });
    cleanup.push(() => app.locals.arenaService.close());
    await request(app).get("/api/accounts").expect(404);
  });
  it("upgrades the original six-column account table without changing profile identity or retaining a unique tag constraint", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "draft-original-schema-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "test.sqlite");
    const database = new DatabaseSync(databasePath);
    const secret = randomBytes(32).toString("hex");
    const username = "original";
    const profileId = "sp_original_profile";
    const token = createHmac("sha256", secret).update(`club-profile:${username}`).digest("base64url");
    const salt = randomBytes(16).toString("hex");
    database.exec(`
      CREATE TABLE club_account_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE social_profiles (id TEXT PRIMARY KEY,display_name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE club_accounts (username TEXT PRIMARY KEY,display_name TEXT NOT NULL,tag TEXT NOT NULL UNIQUE,salt TEXT NOT NULL,password_hash TEXT NOT NULL,profile_id TEXT NOT NULL UNIQUE);
    `);
    database.prepare("INSERT INTO club_account_meta VALUES('identity_secret',?)").run(secret);
    database.prepare("INSERT INTO social_profiles VALUES(?,?,?,?,?)").run(profileId, "Original", createHash("sha256").update(token).digest("hex"), 1, 1);
    database.prepare("INSERT INTO club_accounts VALUES(?,?,?,?,?,?)").run(username, "Original", "#P0LYQ", salt, scryptSync("old display password", salt, 32).toString("hex"), profileId);
    database.close();

    const app = createArenaApp({ catalog, catalogVersion: "test", databasePath });
    const accounts = app.locals.accountService as AccountService;
    expect(accounts.list()).toEqual([expect.objectContaining({ profileId, tag: "#P0LYQ" })]);
    expect(() => accounts.login({ username: "Original", password: "old display password" })).toThrow(/one-time password migration/i);
    expect(accounts.register({ displayName: "AlsoTracking", tag: "#P0LYQ", password: "different durable password" }).account.tag).toBe("#P0LYQ");
    app.locals.arenaService.close();

    const migrated = new DatabaseSync(databasePath);
    const columns = (migrated.prepare("PRAGMA table_info(club_accounts)").all() as Array<{ name: string }>).map((column) => column.name);
    const tagIndexes = (migrated.prepare("PRAGMA index_list(club_accounts)").all() as Array<{ name: string; unique: number }>).filter((index) => {
      const indexed = migrated.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ name: string }>;
      return indexed.some((column) => column.name === "tag");
    });
    expect(columns).toEqual(expect.arrayContaining(["password_version", "credential_version", "collection_json"]));
    expect(tagIndexes).toEqual([expect.objectContaining({ unique: 0 })]);
    expect(migrated.prepare("SELECT count(*) AS count FROM social_profiles WHERE id=?").get(profileId)?.count).toBe(1);
    migrated.close();
  });
  it("revokes a legacy bearer across every protected surface and preserves data after credential migration", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "draft-legacy-accounts-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "test.sqlite");
    const options = { catalog, catalogVersion: "test", databasePath };
    let app = createArenaApp(options);
    let accounts = app.locals.accountService as AccountService;
    const legacy = accounts.register({ displayName: "LegacyPlayer", tag: "#P0LYQ", password: "temporary secure pass" });
    const friend = accounts.register({ displayName: "TrustedFriend", tag: "#28PYL", password: "another secure phrase" });
    const legacyBearer = { Authorization: `Bearer ${legacy.credential.token}` };
    const friendBearer = { Authorization: `Bearer ${friend.credential.token}` };
    const link = await request(app).post("/api/social/friend-links").set(legacyBearer).send({ commandId: "legacy-link" }).expect(201);
    await request(app).post("/api/social/friend-links/accept").set(friendBearer)
      .send({ token: link.body.friendLink.token, commandId: "friend-accept" }).expect(200);
    await request(app).post("/api/decks").set(legacyBearer).send({
      commandId: "saved-before-upgrade",
      deck: { id: "legacy-deck", name: "Preserved deck", mode: "classic", cards: ["hog-rider", "musketeer", "ice-golem", "skeletons", "ice-spirit", "cannon", "fireball", "the-log"] },
    }).expect(201);
    await request(app).post("/api/tracker/manual").set(legacyBearer).send({
      commandId: "history-before-upgrade", battleTime: "2026-09-20T12:00:00Z", type: "friendly",
      mode: { name: "Friendly" }, teamAProfileIds: [legacy.account.profileId], teamBProfileIds: [friend.account.profileId],
      winner: "a", crownsA: 1, crownsB: 0,
    }).expect(201);
    app.locals.arenaService.close();

    let database = new DatabaseSync(databasePath);
    const identitySecret = String(database.prepare("SELECT value FROM club_account_meta WHERE key='identity_secret'").get()?.value);
    const oldToken = createHmac("sha256", identitySecret).update("club-profile:legacyplayer").digest("base64url");
    database.prepare("UPDATE club_accounts SET password_version=0,credential_version=0 WHERE username='legacyplayer'").run();
    database.prepare("UPDATE social_profiles SET token_hash=? WHERE id=?").run(createHash("sha256").update(oldToken).digest("hex"), legacy.account.profileId);
    database.close();

    app = createArenaApp(options);
    accounts = app.locals.accountService as AccountService;
    expect(accounts.list().map((account) => account.displayName)).toEqual(["LegacyPlayer", "TrustedFriend"]);
    expect(() => accounts.login({ username: "LegacyPlayer", password: "temporary secure pass" })).toThrow(/one-time password migration/i);
    const oldBearer = { Authorization: `Bearer ${oldToken}` };
    await request(app).get("/api/accounts/session").set(oldBearer).expect(401);
    await request(app).get("/api/social/state").set(oldBearer).expect(401);
    await request(app).get("/api/decks/mine").set(oldBearer).expect(401);
    await request(app).get("/api/tracker/summary").set(oldBearer).expect(401);
    app.locals.arenaService.close();

    database = new DatabaseSync(databasePath);
    const salt = randomBytes(16).toString("hex");
    const migratedPassword = "new migrated password";
    const credentialVersion = 1;
    const migratedToken = createHmac("sha256", identitySecret).update(`club-profile:legacyplayer:v${credentialVersion}`).digest("base64url");
    database.exec("BEGIN IMMEDIATE;");
    database.prepare("UPDATE club_accounts SET salt=?,password_hash=?,password_version=1,credential_version=? WHERE username='legacyplayer'")
      .run(salt, scryptSync(migratedPassword, salt, 32).toString("hex"), credentialVersion);
    database.prepare("UPDATE social_profiles SET token_hash=? WHERE id=?")
      .run(createHash("sha256").update(migratedToken).digest("hex"), legacy.account.profileId);
    database.exec("COMMIT;");
    database.close();

    app = createArenaApp(options);
    accounts = app.locals.accountService as AccountService;
    expect(() => accounts.login({ username: "LegacyPlayer", password: "temporary secure pass" })).toThrow("incorrect");
    const migrated = accounts.login({ username: "LegacyPlayer", password: migratedPassword });
    expect(migrated.credential.profileId).toBe(legacy.account.profileId);
    expect(migrated.credential.token).not.toBe(migratedToken);
    await request(app).get("/api/accounts/session").set(oldBearer).expect(401);
    await request(app).get("/api/accounts/session").set({ Authorization: `Bearer ${migratedToken}` }).expect(401);
    const migratedBearer = { Authorization: `Bearer ${migrated.credential.token}` };
    expect((await request(app).get("/api/social/state").set(migratedBearer).expect(200)).body.state.friends).toHaveLength(1);
    expect((await request(app).get("/api/decks/mine").set(migratedBearer).expect(200)).body.decks).toEqual([expect.objectContaining({ name: "Preserved deck" })]);
    expect((await request(app).get("/api/tracker/summary").set(migratedBearer).expect(200)).body.summary.recentGames).toHaveLength(1);
    app.locals.arenaService.close();

    app = createArenaApp(options);
    cleanup.push(() => app.locals.arenaService.close());
    expect((app.locals.accountService as AccountService).login({ username: "LegacyPlayer", password: migratedPassword }).credential.profileId).toBe(legacy.account.profileId);
    await request(app).get("/api/social/state").set(oldBearer).expect(401);
  });

  it("persists account-owned collections and uses one-time recovery to revoke every older session", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "draft-account-recovery-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const options = { catalog, catalogVersion: "test", databasePath: path.join(dir, "test.sqlite") };
    let app = createArenaApp(options);
    const registered = (app.locals.accountService as AccountService).register({ displayName: "Recoverable", password: "first durable password" });
    const firstBearer = { Authorization: `Bearer ${registered.credential.token}` };
    const second = (app.locals.accountService as AccountService).login({ username: "Recoverable", password: "first durable password" });
    const secondBearer = { Authorization: `Bearer ${second.credential.token}` };
    await request(app).patch("/api/accounts/profile").set(firstBearer).send({ tag: "#P0LYQ" }).expect(200);
    const collection = { cards: ["knight", "archers"], forms: { archers: ["base"] }, source: "manual" };
    await request(app).put("/api/accounts/collection").set(firstBearer).send({ collection }).expect(200);
    app.locals.arenaService.close();

    app = createArenaApp(options);
    cleanup.push(() => app.locals.arenaService.close());
    expect((await request(app).get("/api/accounts/session").set(firstBearer).expect(200)).body).toMatchObject({
      account: { tag: "#P0LYQ", profileId: registered.account.profileId }, collection,
    });
    await request(app).post("/api/accounts/recovery/rotate").set(firstBearer).send({ password: "wrong durable password" }).expect(401);
    const rotated = await request(app).post("/api/accounts/recovery/rotate").set(firstBearer).send({ password: "first durable password" }).expect(200);
    expect(rotated.body.recoveryCode).toMatch(/^DR-/);
    expect(rotated.body.recoveryCode).not.toBe(registered.recoveryCode);
    await request(app).post("/api/accounts/recover").send({
      username: "Recoverable", recoveryCode: registered.recoveryCode, newPassword: "replacement durable password",
    }).expect(401);
    const recovered = await request(app).post("/api/accounts/recover").send({
      username: "Recoverable", recoveryCode: rotated.body.recoveryCode, newPassword: "replacement durable password",
    }).expect(200);
    expect(recovered.body.recoveryCode).toMatch(/^DR-/);
    expect(recovered.body.recoveryCode).not.toBe(registered.recoveryCode);
    await request(app).get("/api/accounts/session").set(firstBearer).expect(401);
    await request(app).get("/api/accounts/session").set(secondBearer).expect(401);
    await request(app).get("/api/accounts/session").set({ Authorization: `Bearer ${recovered.body.credential.token}` }).expect(200);
    await request(app).post("/api/accounts/recover").send({
      username: "Recoverable", recoveryCode: registered.recoveryCode, newPassword: "another durable password",
    }).expect(401);
  });

  it("keeps Google disabled without operator configuration and validates nonce, issuer, audience, expiry, and safe linking when configured", async () => {
    const disabled = createArenaApp({ catalog, catalogVersion: "test", databasePath: ":memory:" });
    cleanup.push(() => disabled.locals.arenaService.close());
    expect((await request(disabled).get("/api/accounts/providers").expect(200)).body.google).toEqual({ enabled: false });
    await request(disabled).post("/api/accounts/google/challenge").send({}).expect(503);

    let nonce = "";
    const app = createArenaApp({
      catalog, catalogVersion: "test", databasePath: ":memory:", googleClientId: "browser-client.apps.googleusercontent.com",
      verifyGoogleIdToken: async (token) => {
        if (token === "rejected") throw new Error("invalid signature");
        return { sub: "google-subject-1", iss: "https://accounts.google.com", aud: "browser-client.apps.googleusercontent.com", exp: Math.floor(Date.now() / 1_000) + 600, nonce, email: "verified@example.test", email_verified: true, name: "Google Friend" };
      },
    });
    cleanup.push(() => app.locals.arenaService.close());
    const agent = request.agent(app);
    let challenge = await agent.post("/api/accounts/google/challenge").send({}).expect(200);
    nonce = challenge.body.nonce;
    await agent.post("/api/accounts/google").send({ credential: "rejected", state: challenge.body.state }).expect(401);
    challenge = await agent.post("/api/accounts/google/challenge").send({}).expect(200);
    nonce = challenge.body.nonce;
    const challengeCookie = String(challenge.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
    const google = await agent.post("/api/accounts/google").send({ credential: "valid", state: challenge.body.state }).expect(201);
    expect(google.body.account).toMatchObject({ profileId: google.body.credential.profileId, tag: null, providers: ["google"], passwordEnabled: false });
    const replay = await request(app).post("/api/accounts/google").set("Cookie", challengeCookie)
      .send({ credential: "valid", state: challenge.body.state }).expect(400);
    expect(replay.body).toMatchObject({ code: "GOOGLE_CHALLENGE_USED" });
    const custom = (app.locals.accountService as AccountService).register({ displayName: "Custom Friend", password: "custom durable password" });
    challenge = await agent.post("/api/accounts/google/challenge").send({}).expect(200);
    nonce = challenge.body.nonce;
    await agent.post("/api/accounts/google").set({ Authorization: `Bearer ${custom.credential.token}` })
      .send({ credential: "valid", state: challenge.body.state, action: "link" }).expect(409);
  });
});
