import { describe, expect, it } from "vitest";
import type { ArenaCard, TrackerCardStat, TrackerCardStats, TrackerTally } from "@draft-royale/shared";
import { deckCardIds, normalizePlayerTag, pickerStats, recordSentence, statsByCardKey } from "./deckStats";

const tally = (wins: number, losses: number): TrackerTally => ({ games: wins + losses, wins, losses, draws: 0, unknown: 0, winRate: wins + losses ? wins / (wins + losses) : null });
const card = (key: string, id: number): ArenaCard => ({ key, id, name: key, elixir: 3, rarity: "common", kind: "troop", families: [], forms: [{ key: "base", label: key, asset: `/${key}.png` }] });
const stat = (id: number, name: string, withTally: TrackerTally, against: TrackerTally): TrackerCardStat => ({ id, key: name.toLowerCase(), name, elixirCost: 3, with: withTally, against, withDelta: null, againstDelta: null, forms: [] });
const catalog = Array.from({ length: 9 }, (_, index) => card(`card-${index}`, 26_000_000 + index));
const cardsByKey = new Map(catalog.map((item) => [item.key, item]));

describe("deck builder stats", () => {
  it("maps id-keyed card stats onto catalog keys and ignores cards outside the catalog", () => {
    const cardStats: TrackerCardStats = { generatedAt: 0, playerTag: "#A", baseline: tally(10, 10), cards: { "26000001": stat(26_000_001, "One", tally(14, 10), tally(3, 5)), "99": stat(99, "Gone", tally(1, 1), tally(0, 0)) } };
    const stats = statsByCardKey(catalog, cardStats);
    expect([...stats.keys()]).toEqual(["card-1"]);
    expect(pickerStats(stats).get("card-1")).toEqual({ games: 24, winRate: 14 / 24, small: false, badge: "58% · 24", description: "Your record with One: 14W 10L · 58% of 24 games. Against it: 3W 5L · 38% of 8 games · small sample." });
    expect(statsByCardKey(catalog, null).size).toBe(0);
  });

  it("writes a record with its sample, or says there is none", () => {
    expect(recordSentence(tally(0, 0))).toBe("no recorded games");
    expect(recordSentence({ ...tally(1, 0), draws: 1, games: 2, winRate: 0.5 })).toBe("1W 0L 1D · 50% of 2 games · small sample");
  });

  it("only yields card ids for a complete deck of eight distinct known cards", () => {
    const keys = catalog.slice(0, 8).map((item) => item.key);
    expect(deckCardIds(keys, cardsByKey)).toEqual(catalog.slice(0, 8).map((item) => item.id));
    expect(deckCardIds([...keys].reverse(), cardsByKey)).toEqual(deckCardIds(keys, cardsByKey));
    expect(deckCardIds(keys.slice(0, 7), cardsByKey)).toBeNull();
    expect(deckCardIds([...keys.slice(0, 7), "unknown"], cardsByKey)).toBeNull();
    expect(deckCardIds([...keys.slice(0, 7), keys[0]!], cardsByKey)).toBeNull();
  });

  it("normalises player tags like the server", () => {
    expect([normalizePlayerTag(" 2pyl0q "), normalizePlayerTag("#8QRJCV"), normalizePlayerTag(null), normalizePlayerTag("")]).toEqual(["#2PYL0Q", "#8QRJCV", "", ""]);
  });
});
