import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArenaCard } from "@draft-royale/shared";
import { createArenaApp } from "../arena/index.js";
import { repoRoot } from "../config.js";
import type { AccountService } from "./service.js";
import type { SocialService } from "../social/service.js";

const catalog = (JSON.parse(readFileSync(path.join(repoRoot, "data/catalog/arena-catalog.json"), "utf8")) as { cards: ArenaCard[] }).cards;
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach((close) => close()));
describe("remembered player accounts", () => {
  it("uses requested case-sensitive player-name passwords and stable profiles across restarts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "draft-accounts-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const options = { catalog, catalogVersion: "test", databasePath: path.join(dir, "test.sqlite") };
    const app = createArenaApp(options);
    const accounts = app.locals.accountService as AccountService;
    expect(accounts.list().map((player) => player.displayName)).toEqual(["PlayerOne", "PlayerThree", "PlayerTwo"]);
    expect(() => accounts.login({ username: "PlayerOne", password: "playerone" })).toThrow("incorrect");
    const first = accounts.login({ username: "PlayerOne", password: "PlayerOne" });
    expect(first.account.tag).toBe("#2PYL0Q8");
    expect(first.state.friends.map((friend) => friend.displayName).sort()).toEqual(["PlayerThree", "PlayerTwo"]);
    const social = app.locals.socialService as SocialService;
    social.removeFriend(social.authenticate(first.credential.token), first.state.friends[0]!.id, { commandId: "remove-one" });
    app.locals.arenaService.close();
    const restored = createArenaApp(options);
    cleanup.push(() => restored.locals.arenaService.close());
    const second = (restored.locals.accountService as AccountService).login({ username: "playerone", password: "PlayerOne" });
    expect(second.credential).toEqual(first.credential);
    expect(second.state.friends).toHaveLength(1);
  });
  it("allows another player while protecting existing names and tags", () => {
    const app = createArenaApp({ catalog, catalogVersion: "test", databasePath: ":memory:" });
    cleanup.push(() => app.locals.arenaService.close());
    const accounts = app.locals.accountService as AccountService;
    const result = accounts.register({ displayName: "NewFriend", tag: "#P0LYQ" });
    expect(result.account.displayName).toBe("NewFriend");
    expect(accounts.login({ username: "NewFriend", password: "NewFriend" }).credential).toEqual(result.credential);
    expect(() => accounts.register({ displayName: "Someone", tag: "#2PYL0Q8" })).toThrow("already has an account");
  });
});
