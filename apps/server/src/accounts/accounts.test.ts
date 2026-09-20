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
    expect(first.state.friends).toEqual([]);
    expect(() => accounts.login({ username: "NewFriend", password: "wrong password value" })).toThrow("incorrect");
    app.locals.arenaService.close();
    const restored = createArenaApp(options);
    cleanup.push(() => restored.locals.arenaService.close());
    const second = (restored.locals.accountService as AccountService).login({ username: "newfriend", password: "correct horse battery" });
    expect(second.credential).toEqual(first.credential);
    expect(second.state.friends).toHaveLength(0);
  });
  it("allows another player while protecting existing names and tags", () => {
    const app = createArenaApp({ catalog, catalogVersion: "test", databasePath: ":memory:" });
    cleanup.push(() => app.locals.arenaService.close());
    const accounts = app.locals.accountService as AccountService;
    const result = accounts.register({ displayName: "NewFriend", tag: "#P0LYQ", password: "a secure local password" });
    expect(result.account.displayName).toBe("NewFriend");
    expect(accounts.login({ username: "NewFriend", password: "a secure local password" }).credential).toEqual(result.credential);
    expect(() => accounts.register({ displayName: "Someone", tag: "#P0LYQ", password: "another secure password" })).toThrow("already has an account");
  });
  it("does not expose the account roster over HTTP", async () => {
    const app = createArenaApp({ catalog, catalogVersion: "test", databasePath: ":memory:" });
    cleanup.push(() => app.locals.arenaService.close());
    await request(app).get("/api/accounts").expect(404);
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
    expect(migrated.credential).toEqual({ profileId: legacy.account.profileId, token: migratedToken });
    await request(app).get("/api/accounts/session").set(oldBearer).expect(401);
    expect((await request(app).get("/api/social/state").set({ Authorization: `Bearer ${migratedToken}` }).expect(200)).body.state.friends).toHaveLength(1);
    expect((await request(app).get("/api/decks/mine").set({ Authorization: `Bearer ${migratedToken}` }).expect(200)).body.decks).toEqual([expect.objectContaining({ name: "Preserved deck" })]);
    expect((await request(app).get("/api/tracker/summary").set({ Authorization: `Bearer ${migratedToken}` }).expect(200)).body.summary.recentGames).toHaveLength(1);
    app.locals.arenaService.close();

    app = createArenaApp(options);
    cleanup.push(() => app.locals.arenaService.close());
    expect((app.locals.accountService as AccountService).login({ username: "LegacyPlayer", password: migratedPassword }).credential.token).toBe(migratedToken);
    await request(app).get("/api/social/state").set(oldBearer).expect(401);
  });
});
