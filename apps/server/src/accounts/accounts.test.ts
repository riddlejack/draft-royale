import { afterEach, describe, expect, it } from "vitest";
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
  it("preserves legacy rows but blocks sign-in until the explicit password migration runs", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "draft-legacy-accounts-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const databasePath = path.join(dir, "test.sqlite");
    const options = { catalog, catalogVersion: "test", databasePath };
    const app = createArenaApp(options);
    const accounts = app.locals.accountService as AccountService;
    accounts.register({ displayName: "LegacyPlayer", tag: "#P0LYQ", password: "temporary secure pass" });
    app.locals.arenaService.close();
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE club_accounts SET password_version=0 WHERE username='legacyplayer'").run();
    database.close();
    const restored = createArenaApp(options);
    cleanup.push(() => restored.locals.arenaService.close());
    const restoredAccounts = restored.locals.accountService as AccountService;
    expect(restoredAccounts.list().map((account) => account.displayName)).toEqual(["LegacyPlayer"]);
    expect(() => restoredAccounts.login({ username: "LegacyPlayer", password: "temporary secure pass" })).toThrow(/one-time password migration/i);
  });
});
