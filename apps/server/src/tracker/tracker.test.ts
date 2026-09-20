import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { SocialService } from "../social/service.js";
import { createTrackerRouter } from "./router.js";
import { createTrackerService, normalizeApiBattle, parseHistoricalImport, type TrackerRegisteredPlayer, type TrackerService } from "./service.js";

const initialPlayers: TrackerRegisteredPlayer[] = [
  { profileId: "a", displayName: "Alpha", tag: "#P0LYQ" },
  { profileId: "b", displayName: "Bravo", tag: "#Y2P8L" },
  { profileId: "c", displayName: "Charlie", tag: "#L8Q9P" },
  { profileId: "d", displayName: "Delta", tag: "#Q9V2C" },
];
const services: TrackerService[] = [];
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const participant = (player: TrackerRegisteredPlayer, crowns?: number, cards: unknown[] = [{ id: 26_000_063, name: "Electro Dragon", rarity: "epic", evolutionLevel: 1, elixirCost: 5 }]) => ({
  tag: player.tag, name: player.displayName, ...(crowns === undefined ? {} : { crowns }), cards,
});
const battle = (team: unknown[], opponent: unknown[], battleTime = "20260908T203000.000Z", modeName = "Friendly") => ({
  battleTime, type: "friendly", gameMode: { id: 72_000_006, name: modeName }, team, opponent,
});
const summary = (service: TrackerService, actor = "a", visible = [actor], filters = {}) => service.getSummary({ actorProfileId: actor, visibleProfileIds: new Set(visible), filters });

const serviceWithLogs = (options: {
  players?: () => TrackerRegisteredPlayer[];
  logs: Record<string, unknown[] | { status: number; retryAfter?: string }>;
  now?: () => number;
  calls?: string[];
  profiles?: Record<string, () => unknown>;
}) => {
  const getPlayers = options.players ?? (() => initialPlayers);
  const service = createTrackerService({
    databasePath: ":memory:", getPlayers, apiToken: "test-token", now: options.now ?? (() => Date.parse("2026-09-08T20:40:00Z")),
    autoStart: false, jitterRatio: 0, quickPollMs: 10_000, maxIdlePollMs: 80_000,
    fetchImpl: (async (input) => {
      const url = String(input);
      const tag = getPlayers().map((player) => player.tag).find((candidate) => url.includes(encodeURIComponent(candidate))) ?? "";
      if (!url.endsWith("/battlelog")) return new Response(JSON.stringify(options.profiles?.[tag]?.() ?? {}), { status: options.profiles?.[tag] ? 200 : 404 });
      options.calls?.push(tag);
      const value = options.logs[tag] ?? [];
      if (!Array.isArray(value)) return new Response("{}", { status: value.status, headers: value.retryAfter ? { "Retry-After": value.retryAfter } : undefined });
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  services.push(service);
  return service;
};

describe("tag-centric collection and migration", () => {
  it("polls a shared tag once and fans the same public observation to both subscribed accounts", async () => {
    const players = [...initialPlayers.slice(0, 2), { profileId: "a2", displayName: "Alpha two", tag: initialPlayers[0]!.tag }];
    const calls: string[] = [];
    const row = battle([participant(players[0]!, 2)], [participant(players[1]!, 1)]);
    const service = serviceWithLogs({ players: () => players, logs: { [players[0]!.tag]: [row], [players[1]!.tag]: [] }, calls });
    await service.syncNow();
    expect(calls.filter((tag) => tag === players[0]!.tag)).toHaveLength(1);
    expect(summary(service, "a", ["a"], { playerTag: players[0]!.tag }).sample).toMatchObject({ games: 1, wins: 1 });
    expect(summary(service, "a2", ["a2"], { playerTag: players[0]!.tag }).sample).toMatchObject({ games: 1, wins: 1 });
    expect(service.getStatus().players.find((player) => player.tag === players[0]!.tag)?.subscriberCount).toBe(2);
  });

  it("keeps old observations attached to the old tag when an account changes tags", async () => {
    let players = initialPlayers.slice(0, 2).map((player) => ({ ...player }));
    const oldTag = players[0]!.tag;
    const row = battle([participant(players[0]!, 2)], [participant(players[1]!, 1)]);
    const logs: Record<string, unknown[]> = { [oldTag]: [row], [players[1]!.tag]: [] };
    const calls: string[] = [];
    const service = serviceWithLogs({ players: () => players, logs, calls });
    await service.syncNow();
    calls.splice(0);
    const newTag = initialPlayers[2]!.tag;
    players = [{ ...players[0]!, tag: newTag }, players[1]!];
    logs[newTag] = [];
    expect(summary(service, "a", ["a"], { playerTag: oldTag }).sample.games).toBe(1);
    expect(summary(service, "a", ["a"], { playerTag: newTag }).sample.games).toBe(0);
    expect(summary(service, "a", ["a"]).filterOptions.players.map((player) => player.tag)).toEqual(expect.arrayContaining([oldTag, newTag]));
    await expect(service.requestSync("a", new Set(["a"]), oldTag)).rejects.toMatchObject({ status: 409, code: "TRACKING_INACTIVE" });
    expect(calls).toEqual([]);
    await service.requestSync("a", new Set(["a"]), newTag);
    expect(calls).toEqual([newTag]);

    players = players.filter((player) => player.profileId !== "a");
    expect(summary(service, "a", ["a"], { playerTag: newTag }).filterOptions.players.find((player) => player.tag === newTag)?.activeProfileIds).toEqual([]);
    await expect(service.requestSync("a", new Set(["a"]), newTag)).rejects.toMatchObject({ status: 409, code: "TRACKING_INACTIVE" });
    expect(calls).toEqual([newTag]);
  });

  it("migrates preexisting participant profile IDs to tag identity without losing history", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "draft-tracker-migration-")); temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "arena.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec(`CREATE TABLE tracker_battles(id TEXT PRIMARY KEY,dedupe_key TEXT NOT NULL UNIQUE,battle_time TEXT NOT NULL,type TEXT NOT NULL,mode_id INTEGER,mode_name TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN('api','manual')),fetched_at INTEGER NOT NULL,created_by TEXT,undone_at INTEGER);
      CREATE TABLE tracker_participants(battle_id TEXT NOT NULL,side INTEGER NOT NULL,position INTEGER NOT NULL,profile_id TEXT,player_tag TEXT NOT NULL,player_name TEXT NOT NULL,crowns INTEGER,result TEXT NOT NULL,elixir_leaked REAL,cards_json TEXT NOT NULL,PRIMARY KEY(battle_id,side,position));`);
    db.prepare("INSERT INTO tracker_battles VALUES(?,?,?,?,?,?,?,?,?,NULL)").run("old", "old-key", "2026-01-01T00:00:00.000Z", "friendly", 1, "Friendly", "api", 1, null);
    db.prepare("INSERT INTO tracker_participants VALUES(?,?,?,?,?,?,?,?,?,?)").run("old", 0, 0, "a", initialPlayers[0]!.tag, "Alpha", 1, "win", null, "[]");
    db.prepare("INSERT INTO tracker_participants VALUES(?,?,?,?,?,?,?,?,?,?)").run("old", 1, 0, "b", initialPlayers[1]!.tag, "Bravo", 0, "loss", null, "[]");
    db.close();
    const service = createTrackerService({ databasePath, getPlayers: () => initialPlayers.slice(0, 2), autoStart: false }); services.push(service);
    expect(summary(service, "a", ["a"], { playerTag: initialPlayers[0]!.tag }).sample).toMatchObject({ games: 1, wins: 1 });
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspection.prepare("SELECT profile_id FROM tracker_participants WHERE battle_id='old' AND side=0").get()).toMatchObject({ profile_id: null });
    inspection.close();
  });
});

describe("normalization, deduplication, and provenance", () => {
  it("deduplicates reciprocal logs and decodes Evo/Hero forms", async () => {
    const cards = [{ id: 1, name: "Evo", evolutionLevel: 1 }, { id: 2, name: "Hero", evolutionLevel: 2 }, { id: 3, name: "Both", evolutionLevel: 3 }];
    const forward = battle([participant(initialPlayers[0]!, 2, cards)], [participant(initialPlayers[1]!, 1)]);
    const reverse = battle([participant(initialPlayers[1]!, 1)], [participant(initialPlayers[0]!, 2, cards)]);
    const service = serviceWithLogs({ logs: { [initialPlayers[0]!.tag]: [forward], [initialPlayers[1]!.tag]: [reverse] } });
    await service.syncNow();
    const result = summary(service, "a", ["a", "b"], { playerTag: initialPlayers[0]!.tag });
    expect(result.recentGames).toHaveLength(1);
    expect(result.recentGames[0]!.participants.find((item) => item.tag === initialPlayers[0]!.tag)!.cards.map((card) => card.form)).toEqual(["evolution", "hero", "heroEvolution"]);
  });

  it("keeps missing crowns unknown and labels duel observations as rounds", () => {
    const normalized = normalizeApiBattle(battle([participant(initialPlayers[0]!)], [participant(initialPlayers[1]!)], undefined, "ClanWarDuel"), Date.now());
    expect(normalized).toMatchObject({ unit: "duel_round" });
    expect(normalized?.participants.map((item) => item.result)).toEqual(["unknown", "unknown"]);
  });

  it("keeps manual observations separate from an API observation with the same event identity", async () => {
    const row = battle([participant(initialPlayers[0]!, 2)], [participant(initialPlayers[1]!, 1)]);
    const service = serviceWithLogs({ logs: { [initialPlayers[0]!.tag]: [row] } });
    await service.syncNow();
    service.addManualResult("a", new Set(["a", "b"]), { commandId: "manual", battleTime: "2026-09-08T20:30:00.000Z", type: "friendly", mode: { id: 72_000_006, name: "Friendly" }, teamAProfileIds: ["a"], teamBProfileIds: ["b"], winner: "a", crownsA: 2, crownsB: 1 });
    const result = summary(service, "a", ["a", "b"], { playerTag: initialPlayers[0]!.tag });
    expect(result.recentGames).toHaveLength(2);
    expect(result.coverage?.sourceCounts).toEqual({ api: 1, manual: 1 });
  });

  it("imports known snapshots idempotently and preserves import provenance", () => {
    const row = battle([participant(initialPlayers[0]!, 2)], [participant(initialPlayers[1]!, 1)]);
    const snapshot = { generatedAt: "2026-06-25T12:00:00Z", source: "API proxy", players: [
      { playerId: "one", tag: initialPlayers[0]!.tag, fetchedAt: "2026-06-25T12:00:00Z", battles: [row] },
      { playerId: "two", tag: initialPlayers[1]!.tag, fetchedAt: "2026-06-25T12:00:00Z", battles: [battle([participant(initialPlayers[1]!, 1)], [participant(initialPlayers[0]!, 2)])] },
    ] };
    const parsed = parseHistoricalImport(snapshot, Date.parse("2026-06-25T12:00:00Z"), "operator_snapshot");
    expect(parsed).toMatchObject({ inputRows: 2, rejectedRows: 0 });
    expect(parsed.battles).toHaveLength(1);
    const service = createTrackerService({ databasePath: ":memory:", getPlayers: () => initialPlayers.slice(0, 2), autoStart: false }); services.push(service);
    expect(service.importHistorical(parsed, "operator_snapshot")).toMatchObject({ insertedRows: 1, duplicateRows: 0 });
    expect(service.importHistorical(parsed, "operator_snapshot")).toMatchObject({ insertedRows: 0, duplicateRows: 1 });
    expect(summary(service, "a", ["a"], { playerTag: initialPlayers[0]!.tag }).recentGames[0]!.provenance.kind).toBe("operator_snapshot");
  });
});

describe("full battle detail", () => {
  const detailed = (battleTime = "20260908T203000.000Z") => ({
    ...battle(
      [{ ...participant(initialPlayers[0]!, 0, [{ id: 26_000_059, name: "Royal Hogs", level: 14, maxLevel: 14, evolutionLevel: 1, elixirCost: 5, iconUrls: { medium: "https://example.test/hogs.png" } }]), startingTrophies: 13_574, trophyChange: -30, kingTowerHitPoints: 0, princessTowersHitPoints: null, clan: { tag: "#2PP0Q", name: "Test Clan" }, supportCards: [{ id: 159_000_000, name: "Tower Princess", level: 15, maxLevel: 16 }] }],
      [{ ...participant(initialPlayers[1]!, 3), startingTrophies: 13_573, trophyChange: 30, kingTowerHitPoints: 7_728, princessTowersHitPoints: [3_182, 3_991] }],
      battleTime, "MirrorDeck_Friendly",
    ),
    deckSelection: "predefined", arena: { id: 54_000_144, name: "Spirit Square" }, leagueNumber: 1, isLadderTournament: false, isHostedMatch: false,
  });

  it("keeps deck selection, trophies, levels, tower troops, and the raw battle without icon URLs", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "draft-tracker-detail-")); temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "arena.sqlite");
    const service = createTrackerService({ databasePath, getPlayers: () => initialPlayers.slice(0, 2), autoStart: false }); services.push(service);
    service.importHistorical(parseHistoricalImport([detailed()], Date.parse("2026-09-08T20:40:00Z"), "user_import"), "user_import");
    const game = summary(service, "a", ["a"], { playerTag: initialPlayers[0]!.tag }).recentGames[0]!;
    expect(game).toMatchObject({ deckSelection: "predefined", arena: { id: 54_000_144, name: "Spirit Square" }, leagueNumber: 1, isLadderTournament: false, isHostedMatch: false });
    const own = game.participants.find((item) => item.tag === initialPlayers[0]!.tag)!;
    expect(own).toMatchObject({ startingTrophies: 13_574, trophyChange: -30, kingTowerHitPoints: 0, princessTowersHitPoints: null, clan: { tag: "#2PP0Q", name: "Test Clan" } });
    expect(own.cards[0]).toMatchObject({ name: "Royal Hogs", level: 14, maxLevel: 14, form: "evolution" });
    expect(own.supportCards?.[0]).toMatchObject({ name: "Tower Princess", level: 15, maxLevel: 16 });
    expect(game.participants.find((item) => item.tag === initialPlayers[1]!.tag)?.princessTowersHitPoints).toEqual([3_182, 3_991]);
    expect(summary(service, "a", ["a"], { playerTag: initialPlayers[0]!.tag }).decks[0]!.cards[0]).not.toHaveProperty("level");
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const raw = inspection.prepare("SELECT raw_json,observer_tag FROM tracker_battle_raw").all() as Array<{ raw_json: string; observer_tag: string }>;
    inspection.close();
    expect(raw).toHaveLength(1);
    expect(raw[0]!.raw_json).not.toContain("iconUrls");
    expect(JSON.parse(raw[0]!.raw_json)).toMatchObject({ deckSelection: "predefined", team: [{ trophyChange: -30 }] });
  });

  it("upgrades a battle recorded before full detail was kept when the API reports it again", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "draft-tracker-upgrade-")); temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "arena.sqlite");
    const row = detailed();
    const players = initialPlayers.slice(0, 2);
    const seed = createTrackerService({ databasePath, getPlayers: () => players, autoStart: false });
    seed.importHistorical(parseHistoricalImport([row], Date.parse("2026-09-08T20:40:00Z"), "operator_snapshot"), "operator_snapshot");
    seed.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`DELETE FROM tracker_battle_raw; UPDATE tracker_battles SET detail_version=0,deck_selection=NULL,arena_id=NULL,arena_name=NULL;
      UPDATE tracker_participants SET trophy_change=NULL,starting_trophies=NULL,support_cards_json=NULL,cards_json='[{"id":26000059,"key":"royal-hogs","name":"Royal Hogs","form":"evolution","elixirCost":5}]' WHERE side=0;`);
    legacy.close();
    const service = createTrackerService({
      databasePath, getPlayers: () => players, apiToken: "test-token", autoStart: false, now: () => Date.parse("2026-09-08T20:41:00Z"),
      fetchImpl: (async (input) => new Response(JSON.stringify(String(input).includes(encodeURIComponent(players[0]!.tag)) ? [row] : []), { status: 200 })) as typeof fetch,
    }); services.push(service);
    expect(summary(service, "a", ["a"], { playerTag: players[0]!.tag }).recentGames[0]!.deckSelection).toBeNull();
    await service.syncNow();
    await service.syncNow();
    const result = summary(service, "a", ["a"], { playerTag: players[0]!.tag });
    expect(result.recentGames).toHaveLength(1);
    expect(result.recentGames[0]).toMatchObject({ deckSelection: "predefined", provenance: { kind: "server_fetch" } });
    expect(result.recentGames[0]!.participants.find((item) => item.tag === players[0]!.tag)).toMatchObject({ trophyChange: -30, cards: [{ level: 14 }] });
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspection.prepare("SELECT count(*) AS count FROM tracker_battle_raw").get()).toMatchObject({ count: 1 });
    inspection.close();
  });
});

describe("profile counter snapshots", () => {
  it("records counters when battles arrive and audits them against recorded battles by type", async () => {
    let timestamp = Date.parse("2026-09-08T20:40:00Z");
    const tag = initialPlayers[0]!.tag;
    let battleCount = 1_000;
    const logs: Record<string, unknown[]> = { [tag]: [battle([participant(initialPlayers[0]!, 2)], [participant(initialPlayers[1]!, 1)], "20260908T203000.000Z")] };
    const service = serviceWithLogs({ now: () => timestamp, logs, profiles: { [tag]: () => ({ tag, battleCount, wins: 600, losses: 400, trophies: 9_000 }) } });
    await service.syncNow([tag]);
    timestamp += 30 * 60_000; battleCount += 1;
    logs[tag] = [{ ...battle([participant(initialPlayers[0]!, 1)], [participant(initialPlayers[1]!, 2)], "20260908T205500.000Z"), type: "PvP" }, ...logs[tag]!];
    await service.syncNow([tag]);
    timestamp += 60_000;
    await service.syncNow([tag]);
    expect(service.getBattleCountAudit(new Set(["a"]), tag)).toMatchObject({ battleCountDelta: 1, recordedByType: [{ type: "PvP", games: 1 }] });
    expect(() => service.getBattleCountAudit(new Set(["b"]), tag)).toThrow("outside your visible tracker scope");
  });
});

describe("adaptive per-tag scheduling and coverage", () => {
  it("lets a healthy tag complete when another tag fails and honors Retry-After per tag", async () => {
    let timestamp = Date.parse("2026-09-08T20:40:00Z");
    const service = serviceWithLogs({ now: () => timestamp, logs: {
      [initialPlayers[0]!.tag]: [battle([participant(initialPlayers[0]!, 2)], [participant(initialPlayers[1]!, 1)])],
      [initialPlayers[1]!.tag]: { status: 429, retryAfter: "120" },
    } });
    await service.syncNow();
    const states = new Map(service.getStatus().players.map((player) => [player.tag, player]));
    expect(states.get(initialPlayers[0]!.tag)).toMatchObject({ battlesSeen: 1, consecutiveFailures: 0, lastError: null });
    expect(states.get(initialPlayers[1]!.tag)?.consecutiveFailures).toBe(1);
    expect((states.get(initialPlayers[1]!.tag)?.nextPollAt ?? 0) - timestamp).toBeGreaterThanOrEqual(120_000);
    timestamp += 1;
  });

  it("backs off idle tags and records non-overlapping windows as possible gaps", async () => {
    let timestamp = Date.parse("2026-09-08T20:40:00Z");
    const logs: Record<string, unknown[]> = { [initialPlayers[0]!.tag]: [battle([participant(initialPlayers[0]!, 2)], [participant(initialPlayers[1]!, 1)], "20260908T203000.000Z")] };
    const service = serviceWithLogs({ now: () => timestamp, logs });
    await service.syncNow([initialPlayers[0]!.tag]);
    const firstNext = service.getStatus().players.find((player) => player.tag === initialPlayers[0]!.tag)!.nextPollAt!;
    timestamp += 60_000;
    logs[initialPlayers[0]!.tag] = [];
    await service.syncNow([initialPlayers[0]!.tag]);
    const idleState = service.getStatus().players.find((player) => player.tag === initialPlayers[0]!.tag)!;
    expect(idleState.idleStreak).toBe(1);
    expect(idleState.nextPollAt! - timestamp).toBe(20_000);
    timestamp += 60_000;
    logs[initialPlayers[0]!.tag] = [battle([participant(initialPlayers[0]!, 1)], [participant(initialPlayers[1]!, 2)], "20260908T204500.000Z")];
    await service.syncNow([initialPlayers[0]!.tag]);
    const state = service.getStatus().players.find((player) => player.tag === initialPlayers[0]!.tag)!;
    expect(firstNext).toBeGreaterThan(Date.parse("2026-09-08T20:40:00Z"));
    expect(state.possibleGapCount).toBe(1);
    expect(summary(service, "a", ["a"], { playerTag: initialPlayers[0]!.tag }).coverage?.possibleGaps).toHaveLength(1);
  });

  it("reports the documented request arithmetic without claiming a quota", () => {
    const five = initialPlayers.concat([{ profileId: "e", displayName: "Echo", tag: "#2PQLV" }]);
    const service = createTrackerService({ databasePath: ":memory:", getPlayers: () => five, apiToken: "token", autoStart: false, quickPollMs: 60_000, maxIdlePollMs: 15 * 60_000 }); services.push(service);
    expect(service.getStatus().requestBudget).toEqual({ trackedTags: 5, quickPollRequestsPerDay: 7_200, maximumIdleRequestsPerDay: 480 });
  });
});

describe("filters and analytics", () => {
  it("uses one date/mode/relationship sample across history, cards, decks, and tallies", async () => {
    const ownCards = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, name: `Own ${index + 1}` }));
    const opponentCards = Array.from({ length: 8 }, (_, index) => ({ id: index + 101, name: `Pain ${index + 1}` }));
    const together = battle(
      [participant(initialPlayers[0]!, 3, ownCards), participant(initialPlayers[2]!, 3)],
      [participant(initialPlayers[1]!, 1, opponentCards), participant(initialPlayers[3]!, 1)],
      "20260908T203000.000Z", "TeamVsTeam",
    );
    const versus = battle([participant(initialPlayers[0]!, 0, ownCards)], [participant(initialPlayers[2]!, 1, opponentCards)], "20260907T203000.000Z", "Friendly");
    const service = serviceWithLogs({ logs: { [initialPlayers[0]!.tag]: [together, versus] } });
    await service.syncNow([initialPlayers[0]!.tag]);
    const result = summary(service, "a", ["a", "b", "c", "d"], { playerTag: initialPlayers[0]!.tag, opponentTag: initialPlayers[2]!.tag, relationship: "alongside", dateFrom: "2026-09-08", dateTo: "2026-09-08", mode: "72000006:TeamVsTeam" });
    expect(result.sample).toMatchObject({ games: 1, wins: 1 });
    expect(result.coverage?.sourceCounts).toEqual({ api: 2, manual: 0 });
    expect(result.recentGames).toHaveLength(1);
    expect(result.opponentCards[0]).toMatchObject({ games: 1, losses: 0 });
    expect(result.decks).toHaveLength(1);
    expect(result.opponentDecks).toHaveLength(2);
    expect(result.deckMatchups).toHaveLength(2);

    const allWithStaleOpponent = summary(service, "a", ["a", "b", "c", "d"], { playerTag: initialPlayers[0]!.tag, opponentTag: initialPlayers[2]!.tag, relationship: "all" });
    const allWithoutOpponent = summary(service, "a", ["a", "b", "c", "d"], { playerTag: initialPlayers[0]!.tag, relationship: "all" });
    expect(allWithStaleOpponent.filters.opponentTag).toBeNull();
    expect(allWithStaleOpponent.sample).toEqual(allWithoutOpponent.sample);
    expect(allWithStaleOpponent.recentGames.map((item) => item.id)).toEqual(allWithoutOpponent.recentGames.map((item) => item.id));
    expect(allWithStaleOpponent.sample.games).toBe(2);
  });

  it("does not expose or allow undo of another same-tag account's private manual result", () => {
    const players = [...initialPlayers.slice(0, 2), { profileId: "a2", displayName: "Alpha two", tag: initialPlayers[0]!.tag }];
    const service = createTrackerService({ databasePath: ":memory:", getPlayers: () => players, autoStart: false }); services.push(service);
    const manual = service.addManualResult("a", new Set(["a", "b"]), { commandId: "private", teamAProfileIds: ["a"], teamBProfileIds: ["b"], winner: "a" });
    expect(summary(service, "a2", ["a2"], { playerTag: initialPlayers[0]!.tag }).recentGames).toHaveLength(0);
    expect(() => service.undoManualResult("a2", new Set(["a2"]), manual.battle.id, { commandId: "steal" })).toThrow("Only the person who entered");
  });
});

describe("tracker HTTP privacy", () => {
  it("rejects unauthenticated summary access before reading tracker data", async () => {
    const tracker = createTrackerService({ databasePath: ":memory:", getPlayers: () => initialPlayers, autoStart: false }); services.push(tracker);
    const social = { authenticate: () => { throw new Error("authenticate should not be called without a bearer token"); } } as unknown as SocialService;
    const app = express(); app.use(express.json()); app.use(createTrackerRouter(tracker, social));
    await request(app).get("/api/tracker/summary").expect(401, { error: "Sign in to view game history", code: "UNAUTHORIZED" });
  });
});
