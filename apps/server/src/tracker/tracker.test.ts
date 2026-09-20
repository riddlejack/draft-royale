import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { SocialService } from "../social/service.js";
import { createTrackerRouter } from "./router.js";
import { createTrackerService, type TrackerRegisteredPlayer, type TrackerService } from "./service.js";

const players: TrackerRegisteredPlayer[] = [
  { profileId: "a", displayName: "PlayerOne", tag: "#P0" },
  { profileId: "b", displayName: "PlayerThree", tag: "#Y2" },
  { profileId: "c", displayName: "PlayerTwo", tag: "#L8" },
  { profileId: "d", displayName: "Fourth", tag: "#Q9" },
];

const services: TrackerService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });

const participant = (player: TrackerRegisteredPlayer, crowns?: number) => ({
  tag: player.tag,
  name: player.displayName,
  ...(crowns === undefined ? {} : { crowns }),
  cards: [{ id: 26_000_063, name: "Electro Dragon", rarity: "epic", evolutionLevel: 1, elixirCost: 5 }],
});

const battle = (team: unknown[], opponent: unknown[], battleTime = "20260908T203000.000Z") => ({
  battleTime,
  type: "friendly",
  gameMode: { id: 72_000_006, name: "Friendly" },
  team,
  opponent,
});

const serviceWithLogs = (logs: Record<string, unknown[]>, now = () => Date.parse("2026-09-08T20:40:00Z")) => {
  const service = createTrackerService({
    databasePath: ":memory:",
    getPlayers: () => players,
    apiToken: "test-token",
    now,
    autoStart: false,
    fetchImpl: (async (input) => {
      const url = String(input);
      const player = players.find((candidate) => url.includes(encodeURIComponent(candidate.tag)));
      return new Response(JSON.stringify(player ? logs[player.profileId] ?? [] : []), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  services.push(service);
  return service;
};

describe("tracker battle normalization and analytics", () => {
  it("deduplicates the same battle when the API reverses team perspective", async () => {
    const first = battle([participant(players[0]!, 2)], [participant(players[1]!, 1)]);
    const reversed = battle([participant(players[1]!, 1)], [participant(players[0]!, 2)]);
    const service = serviceWithLogs({ a: [first], b: [reversed] });
    await service.syncNow();

    const summary = service.getSummary(new Set(["a", "b"]));
    expect(summary.recentGames).toHaveLength(1);
    expect(summary.players.find((player) => player.profileId === "a")).toMatchObject({ games: 1, wins: 1, losses: 0 });
    expect(summary.players.find((player) => player.profileId === "b")).toMatchObject({ games: 1, wins: 0, losses: 1 });
    expect(summary.recentGames[0]!.participants[0]!.cards[0]).toMatchObject({ key: "electro-dragon", form: "evolution" });
  });

  it("keeps games with missing crown fields unscored instead of fabricating losses", async () => {
    const service = serviceWithLogs({ a: [battle([participant(players[0]!)], [participant(players[1]!)])] });
    await service.syncNow();

    const summary = service.getSummary(new Set(["a", "b"]));
    expect(summary.players.find((player) => player.profileId === "a")).toMatchObject({ games: 1, wins: 0, losses: 0, draws: 0, unknown: 1, winRate: null });
    expect(summary.players.find((player) => player.profileId === "b")).toMatchObject({ games: 1, wins: 0, losses: 0, draws: 0, unknown: 1, winRate: null });
  });

  it("counts opposite-side rivals as head-to-head and same-side players as 2v2 partners", async () => {
    const twoVersusTwo = battle(
      [participant(players[0]!, 3), participant(players[1]!, 3)],
      [participant(players[2]!, 1), participant(players[3]!, 1)],
    );
    const service = serviceWithLogs({ a: [twoVersusTwo] });
    await service.syncNow();

    const summary = service.getSummary(new Set(players.map((player) => player.profileId)));
    const h2hKeys = summary.headToHead.map((pair) => [pair.leftProfileId, pair.rightProfileId].sort().join(":"));
    const coPlayKeys = summary.coPlay.map((pair) => [pair.leftProfileId, pair.rightProfileId].sort().join(":"));
    expect(h2hKeys).toEqual(expect.arrayContaining(["a:c", "a:d", "b:c", "b:d"]));
    expect(h2hKeys).not.toContain("a:b");
    expect(h2hKeys).not.toContain("c:d");
    expect(coPlayKeys).toEqual(expect.arrayContaining(["a:b", "c:d"]));
  });

  it("replays a manual command without counting the result twice and supports idempotent undo", () => {
    const service = createTrackerService({ databasePath: ":memory:", getPlayers: () => players, autoStart: false, now: () => Date.parse("2026-09-08T20:40:00Z") });
    services.push(service);
    const scope = new Set(["a", "b"]);
    const input = { commandId: "manual-1", battleTime: "2026-09-08T20:39:00Z", type: "friendly", mode: { name: "Friendly" }, teamAProfileIds: ["a"], teamBProfileIds: ["b"], winner: "a" as const };
    const first = service.addManualResult("a", scope, input);
    const replay = service.addManualResult("a", scope, input);
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, battle: { id: first.battle.id } });
    expect(service.getSummary(scope).recentGames).toHaveLength(1);

    const undo = service.undoManualResult("a", scope, first.battle.id, { commandId: "undo-1" });
    const undoReplay = service.undoManualResult("a", scope, first.battle.id, { commandId: "undo-1" });
    expect(undo).toMatchObject({ undone: true, replayed: false });
    expect(undoReplay).toMatchObject({ replayed: true });
    expect(service.getSummary(scope).recentGames).toHaveLength(0);
  });

  it("keeps all-time tallies beyond the former history cap while bounding only the recent list", () => {
    const service = createTrackerService({ databasePath: ":memory:", getPlayers: () => players, autoStart: false, now: () => Date.parse("2026-09-08T20:40:00Z") });
    services.push(service);
    const scope = new Set(["a", "b"]);
    const firstGame = Date.parse("2020-01-01T00:00:00Z");
    for (let index = 0; index < 5_001; index += 1) service.addManualResult("a", scope, {
      commandId: `history-${index}`,
      battleTime: new Date(firstGame + index).toISOString(),
      type: "friendly",
      mode: { name: "Friendly" },
      teamAProfileIds: ["a"],
      teamBProfileIds: ["b"],
      winner: "a",
    });

    const summary = service.getSummary(scope);
    expect(summary.players.find((player) => player.profileId === "a")).toMatchObject({ games: 5_001, wins: 5_001 });
    expect(summary.headToHead[0]).toMatchObject({ games: 5_001, wins: 5_001 });
    expect(summary.recentGames).toHaveLength(50);
  });
});

describe("tracker HTTP privacy", () => {
  it("rejects unauthenticated summary access before reading tracker data", async () => {
    const tracker = createTrackerService({ databasePath: ":memory:", getPlayers: () => players, autoStart: false });
    services.push(tracker);
    const social = {
      authenticate: () => { throw new Error("authenticate should not be called without a bearer token"); },
    } as unknown as SocialService;
    const app = express();
    app.use(express.json());
    app.use(createTrackerRouter(tracker, social));
    await request(app).get("/api/tracker/summary").expect(401, { error: "Sign in to view game history", code: "UNAUTHORIZED" });
  });
});
