import { describe, expect, it } from "vitest";
import { insightsSearch, localTzOffsetMinutes } from "./client";
import { costliestRivalCards } from "./RivalryBoard";
import { isStatsHash, statsHash, statsTabFromHash } from "./statsTabs";
import type { TrackerCardTally } from "@draft-royale/shared";

describe("stats tab routing", () => {
  it("keeps #stats as the history tab and round-trips the other tabs", () => {
    expect(statsTabFromHash("#stats")).toBe("history");
    expect(statsTabFromHash("#stats/rivalries")).toBe("rivalries");
    expect(statsTabFromHash(statsHash("insights"))).toBe("insights");
    expect(statsTabFromHash("#stats/unknown")).toBe("history");
    expect(statsHash("history")).toBe("#stats");
  });

  it("recognises only the stats surface", () => {
    expect([isStatsHash("#stats"), isStatsHash("#stats/insights"), isStatsHash("#statsy"), isStatsHash("#decks"), isStatsHash("")]).toEqual([true, true, false, false, false]);
  });
});

describe("insights query", () => {
  it("sends only set filters, the assigned flag as 1, and always the timezone offset", () => {
    expect(insightsSearch({ playerTag: "#ABC", mode: "", dateFrom: null, includeAssigned: true }, -300).toString()).toBe("playerTag=%23ABC&includeAssigned=1&tzOffsetMinutes=-300");
    expect(insightsSearch({}, 0).toString()).toBe("tzOffsetMinutes=0");
  });

  it("adds minutes to UTC, the opposite sign of getTimezoneOffset", () => {
    expect(localTzOffsetMinutes({ getTimezoneOffset: () => 300 } as Date)).toBe(-300);
    expect(localTzOffsetMinutes({ getTimezoneOffset: () => -600 } as Date)).toBe(600);
    expect(localTzOffsetMinutes({ getTimezoneOffset: () => Number.NaN } as Date)).toBe(0);
  });
});

describe("costliest rival cards", () => {
  const tally = (name: string, wins: number, losses: number): TrackerCardTally => ({ playerTag: "#A", card: { id: null, key: name, name, form: "base", elixirCost: 3 }, games: wins + losses, wins, losses, draws: 0, unknown: 0, winRate: wins + losses ? wins / (wins + losses) : null });
  it("orders by losses, then the lower win rate, and leaves out cards never lost to", () => {
    expect(costliestRivalCards([tally("Knight", 5, 0), tally("Hog", 4, 3), tally("Log", 1, 3), tally("Zap", 0, 6)]).map((item) => item.card.name)).toEqual(["Zap", "Log", "Hog"]);
  });
});
