import type { TrackerBattle, TrackerBattleResult, TrackerCard, TrackerInsightsFilters, TrackerParticipant, TrackerPlayer } from "@draft-royale/shared";
import { describe, expect, it } from "vitest";
import { buildCardStats, buildDeckRecord, buildInsights, wilsonInterval } from "./insights.js";

const ME = "#P0LYQ"; const RIVAL = "#Y2P8L"; const STRANGER = "#L8Q9P"; const OTHER = "#Q9V2C";
const person = (tag: string, displayName: string): TrackerPlayer => ({ tag, displayName, linkedProfileIds: [displayName.toLowerCase()], activeProfileIds: [displayName.toLowerCase()] });
const players = [person(ME, "Me"), person(RIVAL, "Rival")];
const card = (id: number, extra: Partial<TrackerCard> = {}): TrackerCard => ({ id, key: `card-${id}`, name: `Card ${id}`, form: "base", elixirCost: 3, ...extra });
const deck = (start: number, extra: Partial<TrackerCard> = {}) => Array.from({ length: 8 }, (_, index) => card(start + index, extra));
const OWN = deck(1);
const opposite: Record<TrackerBattleResult, TrackerBattleResult> = { win: "loss", loss: "win", draw: "draw", unknown: "unknown" };
const side = (tag: string, sideIndex: 0 | 1, result: TrackerBattleResult, cards: TrackerCard[], extra: Partial<TrackerParticipant> = {}): TrackerParticipant =>
  ({ profileId: null, tag, name: tag, side: sideIndex, crowns: null, result, elixirLeaked: null, cards, ...extra });
let sequence = 0;
const game = (battleTime: string, participants: TrackerParticipant[], extra: Partial<TrackerBattle> = {}): TrackerBattle => ({
  id: `battle_${String(sequence += 1).padStart(5, "0")}`, battleTime, type: "PvP", mode: { id: 72_000_006, name: "Ladder" }, source: "api", unit: "match", fetchedAt: 0,
  provenance: { kind: "server_fetch", label: "test", observedAt: 0 }, deckSelection: "collection", participants, ...extra,
});
/** A 1v1 for ME, `minute` minutes after a fixed start. */
const duel = (minute: number, result: TrackerBattleResult, opponentCards: TrackerCard[], extra: Partial<TrackerBattle> = {}, own: Partial<TrackerParticipant> = {}, other: Partial<TrackerParticipant> = {}, opponentTag = STRANGER) =>
  game(new Date(Date.parse("2026-09-08T12:00:00.000Z") + minute * 60_000).toISOString(), [side(ME, 0, result, OWN, own), side(opponentTag, 1, opposite[result], opponentCards, other)], extra);
const filters = (extra: Partial<TrackerInsightsFilters> = {}): TrackerInsightsFilters => ({ playerTag: ME, rivalTag: null, mode: null, dateFrom: null, dateTo: null, includeAssigned: false, tzOffsetMinutes: 0, ...extra });
const mirror = { deckSelection: "predefined", mode: { id: 72_000_009, name: "MirrorDeck_Friendly" }, type: "friendly" } satisfies Partial<TrackerBattle>;

describe("card insights", () => {
  const battles = [
    ...Array.from({ length: 5 }, (_, index) => duel(index * 60, "loss", deck(101))),
    ...Array.from({ length: 20 }, (_, index) => duel(1_000 + index * 60, index < 4 ? "win" : "loss", deck(301))),
    ...Array.from({ length: 4 }, (_, index) => duel(5_000 + index * 60, "loss", deck(401))),
    ...Array.from({ length: 30 }, (_, index) => duel(9_000 + index * 60, "win", deck(201))),
  ];

  it("measures every card against the baseline and carries the sample behind each rate", () => {
    const insights = buildInsights(battles, players, filters());
    expect(insights.baseline).toMatchObject({ games: 59, wins: 34, losses: 25 });
    const faced = insights.cards.find((entry) => entry.card.id === 101)!;
    expect(faced.againstCard).toMatchObject({ games: 5, wins: 0, losses: 5, winRate: 0 });
    expect(faced.againstDelta).toBeCloseTo(-34 / 59);
    expect(faced.againstInterval!.upper).toBeCloseTo(0.4345, 3);
    expect(faced.withCard.games).toBe(0);
    expect(faced.withDelta).toBeNull();
    const own = insights.cards.find((entry) => entry.card.id === 1)!;
    expect(own.withCard).toMatchObject({ games: 59, wins: 34 });
    expect(own.withDelta).toBeCloseTo(0);
  });

  it("requires five decided games and ranks a long losing record above a lopsided handful", () => {
    const insights = buildInsights(battles, players, filters());
    expect(insights.rankingMinDecided).toBe(5);
    expect(insights.blindSpots).toHaveLength(12);
    expect(insights.blindSpots.slice(0, 8).map((entry) => entry.card.id)).toEqual([301, 302, 303, 304, 305, 306, 307, 308]);
    expect(insights.blindSpots.slice(8).every((entry) => entry.card.id! >= 101 && entry.card.id! <= 108)).toBe(true);
    expect(insights.blindSpots.some((entry) => entry.card.id! >= 401)).toBe(false);
    expect(insights.cards.find((entry) => entry.card.id === 401)!.againstCard.games).toBe(4);
    expect(insights.strengths.map((entry) => entry.card.id)).toEqual([201, 202, 203, 204, 205, 206, 207, 208]);
    expect(insights.strengths[0]!.againstInterval!.lower).toBeGreaterThan(0.88);
  });

  it("counts chosen decks only unless assigned decks are requested, and never duels or partial decks", () => {
    const mixed = [
      duel(0, "win", deck(101)),
      duel(60, "loss", deck(101), mirror),
      // Recorded before deckSelection was kept, so the mode name decides.
      duel(120, "loss", deck(101), { deckSelection: null, mode: { id: null, name: "Touchdown_Draft" } }),
      duel(180, "loss", deck(101), { unit: "duel_round" }),
      game("2026-09-08T18:00:00.000Z", [side(ME, 0, "loss", OWN.slice(0, 5)), side(STRANGER, 1, "win", deck(101))]),
    ];
    const chosen = buildInsights(mixed, players, filters());
    expect(chosen.sample.games).toBe(5);
    expect(chosen.baseline).toMatchObject({ games: 1, wins: 1 });
    expect(chosen.cards.find((entry) => entry.card.id === 101)!.againstCard).toMatchObject({ games: 1, wins: 1 });
    const everything = buildInsights(mixed, players, filters({ includeAssigned: true }));
    expect(everything.baseline).toMatchObject({ games: 3, wins: 1, losses: 2 });
    expect(everything.cards.find((entry) => entry.card.id === 101)!.againstCard.games).toBe(3);
  });

  it("applies the mode and inclusive UTC date filters and lists the focus player's modes", () => {
    const mixed = [duel(0, "win", deck(101)), duel(24 * 60, "loss", deck(101)), duel(48 * 60, "loss", deck(101), { mode: { id: null, name: "Classic" } })];
    expect(buildInsights(mixed, players, filters({ dateFrom: "2026-09-09", dateTo: "2026-09-09" })).sample).toMatchObject({ games: 1, losses: 1 });
    const classic = buildInsights(mixed, players, filters({ mode: "name:Classic" }));
    expect(classic.sample.games).toBe(1);
    expect(classic.filterOptions.modes).toEqual([{ key: "name:Classic", name: "Classic" }, { key: "72000006:Ladder", name: "Ladder" }]);
  });

  it("returns no interval without decided games", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(4, 20)!.upper).toBeCloseTo(0.416, 3);
  });
});

describe("level gap", () => {
  const levelled = (belowMax: number[]) => OWN.map((entry, index) => ({ ...entry, id: entry.id! + 500, level: 14 - (belowMax[index] ?? 0), maxLevel: 14 }));
  const own = (belowMax: number[]) => ({ cards: levelled(belowMax).map((entry) => ({ ...entry, id: entry.id - 500 })) });
  const gapGame = (minute: number, result: TrackerBattleResult, mine: number[], theirs: number[]) => duel(minute, result, levelled(theirs), {}, own(mine));

  it("buckets the mean level deficit and skips 2v2 and battles with a missing level", () => {
    const battles = [
      gapGame(0, "loss", [3, 3, 3, 3, 3, 3, 3, 3], [2, 2, 2, 2, 2, 2, 2, 2]),
      gapGame(60, "loss", [1, 1, 1], []),
      gapGame(120, "win", [1, 1], []),
      gapGame(180, "win", [], [1, 1, 1, 1]),
      gapGame(240, "win", [], [1, 1, 1, 1, 1, 1, 1, 1]),
      duel(300, "win", deck(101)),
      game("2026-09-08T20:00:00.000Z", [side(ME, 0, "win", own([]).cards), side(RIVAL, 0, "win", levelled([])), side(STRANGER, 1, "loss", levelled([2])), side(OTHER, 1, "loss", levelled([2]))]),
    ];
    const { levelGap } = buildInsights(battles, players, filters());
    expect(levelGap.battles).toBe(5);
    expect(levelGap.meanGap).toBeCloseTo((1 + 0.375 + 0.25 - 0.5 - 1) / 5);
    expect(levelGap.buckets.map((entry) => [entry.key, entry.games, entry.wins])).toEqual([["ahead_major", 1, 1], ["ahead_minor", 1, 1], ["even", 1, 1], ["behind_minor", 1, 0], ["behind_major", 1, 0]]);
  });
});

describe("tilt and time", () => {
  const session = [duel(0, "loss", deck(101)), duel(5, "loss", deck(101)), duel(10, "loss", deck(101)), duel(15, "win", deck(101), { mode: { id: null, name: "Classic" } }), duel(46, "win", deck(101))];

  it("splits sessions on a gap over thirty minutes and tallies by the losses directly before each battle", () => {
    const { tilt } = buildInsights(session, players, filters());
    expect(tilt).toMatchObject({ sessionGapMinutes: 30, sessionCount: 2, medianSessionLength: 2.5 });
    expect(tilt.byPriorLosses.map((entry) => [entry.key, entry.games, entry.wins])).toEqual([["0", 2, 1], ["1", 1, 0], ["2", 1, 0], ["3+", 1, 1]]);
    expect(tilt.byPosition.map((entry) => [entry.key, entry.games])).toEqual([["1-3", 4], ["4-6", 1], ["7-10", 0], ["11+", 0]]);
    expect(buildInsights([...session.slice(0, 4), duel(45, "win", deck(101))], players, filters()).tilt.sessionCount).toBe(1);
  });

  it("keeps losses from other modes in view when a mode filter narrows what is tallied", () => {
    const { tilt, sample } = buildInsights(session, players, filters({ mode: "name:Classic" }));
    expect(sample.games).toBe(1);
    expect(tilt).toMatchObject({ sessionCount: 1, medianSessionLength: 4 });
    expect(tilt.byPriorLosses.map((entry) => entry.games)).toEqual([0, 0, 0, 1]);
    expect(tilt.byPosition.map((entry) => entry.games)).toEqual([0, 1, 0, 0]);
  });

  it("buckets hours and weekdays in the viewer's local time", () => {
    const late = [game("2026-09-08T23:30:00.000Z", [side(ME, 0, "win", OWN), side(STRANGER, 1, "loss", deck(101))])];
    const utc = buildInsights(late, players, filters()).time;
    expect(utc.byHour).toHaveLength(24);
    expect(utc.byHour[23]).toMatchObject({ hour: 23, games: 1, wins: 1 });
    expect(utc.byWeekday[2]).toMatchObject({ weekday: 2, label: "Tuesday", games: 1 });
    const ahead = buildInsights(late, players, filters({ tzOffsetMinutes: 120 })).time;
    expect(ahead.byHour[1]!.games).toBe(1);
    expect(ahead.byWeekday[3]).toMatchObject({ label: "Wednesday", games: 1 });
    const behind = buildInsights(late, players, filters({ tzOffsetMinutes: -300 })).time;
    expect(behind.byHour[18]!.games).toBe(1);
    expect(behind.byWeekday[2]!.games).toBe(1);
  });
});

describe("trophies, elixir and matchups", () => {
  it("builds a trophy series per battle type, oldest first", () => {
    const battles = [
      duel(60, "loss", deck(101), {}, { startingTrophies: 9_030, trophyChange: -28 }),
      duel(0, "win", deck(101), {}, { startingTrophies: 9_000, trophyChange: 30 }),
      duel(120, "win", deck(101), { type: "pathOfLegend" }, { startingTrophies: 1_500, trophyChange: 0 }),
      duel(180, "win", deck(101), {}, { startingTrophies: 9_002 }),
    ];
    const { trophyTimeline } = buildInsights(battles, players, filters());
    expect(trophyTimeline.map((series) => [series.type, series.points.map((point) => point.trophies)])).toEqual([["PvP", [9_030, 9_002]], ["pathOfLegend", [1_500]]]);
    expect(trophyTimeline[0]!.points[1]).toMatchObject({ change: -28, modeName: "Ladder", type: "PvP" });
  });

  it("averages leaked elixir by result for 1v1 only and groups opposing decks by cost and tower troop", () => {
    const princess = { supportCards: [card(159_000_000, { name: "Tower Princess", elixirCost: null })] };
    const battles = [
      duel(0, "win", deck(101, { elixirCost: 2 }), {}, { elixirLeaked: 1 }, princess),
      duel(60, "win", deck(101, { elixirCost: 4 }), {}, { elixirLeaked: 2 }, princess),
      duel(120, "loss", deck(101, { elixirCost: 5 }), {}, { elixirLeaked: 9 }),
      duel(180, "loss", [...deck(101).slice(0, 7), card(108, { elixirCost: null })], {}, { elixirLeaked: null }),
      game("2026-09-08T20:00:00.000Z", [side(ME, 0, "win", OWN, { elixirLeaked: 40 }), side(RIVAL, 0, "win", deck(51)), side(STRANGER, 1, "loss", deck(101, { elixirCost: 2 }), princess), side(OTHER, 1, "loss", deck(201, { elixirCost: 2.5 }), princess)]),
    ];
    const { elixirLeaked, matchups } = buildInsights(battles, players, filters());
    expect(elixirLeaked).toEqual({ wins: { games: 2, meanLeaked: 1.5 }, losses: { games: 1, meanLeaked: 9 } });
    expect(matchups.byElixirBand.map((entry) => [entry.key, entry.games, entry.wins])).toEqual([["lt3.0", 2, 2], ["3.0-3.5", 0, 0], ["3.5-4.0", 0, 0], ["4.0-4.5", 1, 1], ["gte4.5", 1, 0]]);
    expect(matchups.byTowerTroop).toHaveLength(1);
    expect(matchups.byTowerTroop[0]).toMatchObject({ card: { name: "Tower Princess" }, games: 3, wins: 3 });
  });
});

describe("rivalries", () => {
  const versus = (minute: number, result: TrackerBattleResult, crowns: [number, number], extra: Partial<TrackerBattle> = {}) => duel(minute, result, deck(101), extra, { crowns: crowns[0] }, { crowns: crowns[1] }, RIVAL);
  const meetings = [
    game("2026-08-31T23:30:00.000Z", [side(ME, 0, "win", OWN, { crowns: 3 }), side(RIVAL, 1, "loss", deck(101), { crowns: 0 })]),
    versus(0, "win", [1, 0]),
    versus(60, "loss", [0, 3], mirror),
    versus(120, "draw", [1, 1], mirror),
    versus(180, "loss", [1, 2]),
    versus(240, "loss", [0, 1], { ...mirror, unit: "duel_round" }),
    duel(300, "win", deck(301)),
    game("2026-09-08T19:00:00.000Z", [side(ME, 0, "win", OWN), side(RIVAL, 0, "win", deck(51)), side(STRANGER, 1, "loss", deck(201)), side(OTHER, 1, "loss", deck(301))], { mode: { id: 72_000_023, name: "TeamVsTeam" } }),
  ];

  it("tracks streaks, months, crowns and the chosen and assigned split from the focus player's side", () => {
    const [rivalry, ...rest] = buildInsights(meetings, players, filters({ tzOffsetMinutes: 120 })).rivalries;
    expect(rest).toEqual([]);
    expect(rivalry).toMatchObject({
      rival: { tag: RIVAL }, sharedBattles: 7, versus: { games: 6, wins: 2, losses: 3, draws: 1, winRate: 1 / 3 }, versusChosen: { games: 3, wins: 2, losses: 1 }, versusAssigned: { games: 3, wins: 0, losses: 2, draws: 1 },
      currentStreak: { kind: "loss", length: 2 }, longestWinStreak: 2, longestLossStreak: 2, crownGames: 6, crownsFor: 6, crownsAgainst: 7, threeCrownWins: 1, threeCrownLosses: 1,
    });
    expect(rivalry!.versusByMonth.map((entry) => [entry.month, entry.games])).toEqual([["2026-09", 6]]);
    expect(buildInsights(meetings, players, filters()).rivalries[0]!.versusByMonth.map((entry) => [entry.month, entry.games])).toEqual([["2026-08", 1], ["2026-09", 5]]);
    expect(rivalry!.versusByMode.map((entry) => [entry.modeKey, entry.games])).toEqual([["72000009:MirrorDeck_Friendly", 3], ["72000006:Ladder", 3]]);
    expect(rivalry!.recentMeetings).toHaveLength(6);
    expect(rivalry!.recentMeetings[0]).toMatchObject({ result: "loss", crownsFor: 0, crownsAgainst: 1, deckSelection: "predefined", deckOrigin: "assigned", unit: "duel_round", modeName: "MirrorDeck_Friendly" });
  });

  it("keeps deck and card lists to chosen decks by default and records 2v2 partners separately", () => {
    const rivalry = buildInsights(meetings, players, filters()).rivalries[0]!;
    expect(rivalry.ownDecks).toHaveLength(1);
    expect(rivalry.ownDecks[0]).toMatchObject({ origin: "chosen", games: 3, wins: 2 });
    expect(rivalry.ownDecks[0]!.cards).toHaveLength(8);
    expect(rivalry.rivalDecks[0]).toMatchObject({ origin: "chosen", games: 3 });
    expect(rivalry.rivalCards).toHaveLength(8);
    expect(rivalry.rivalCards[0]).toMatchObject({ playerTag: ME, games: 3, wins: 2, losses: 1 });
    expect(rivalry.alongside.tally).toMatchObject({ games: 1, wins: 1 });
    expect(rivalry.alongside.byMode).toMatchObject([{ modeName: "TeamVsTeam", games: 1 }]);
    expect(rivalry.alongside.duoDecks).toHaveLength(1);
    expect(rivalry.alongside.duoDecks[0]!.partnerCards[0]!.id).toBe(51);
    const everything = buildInsights(meetings, players, filters({ includeAssigned: true })).rivalries[0]!;
    // The duel round stays out of deck lists even then.
    expect(everything.ownDecks.map((entry) => [entry.origin, entry.games])).toEqual([["chosen", 3], ["assigned", 2]]);
    expect(everything.versus).toEqual(rivalry.versus);
  });

  it("only reports visible players, and only the selected rival when one is given", () => {
    const third = person(OTHER, "Other");
    const all = buildInsights(meetings, [...players, third], filters());
    expect(all.rivalries.map((entry) => [entry.rival.tag, entry.sharedBattles])).toEqual([[RIVAL, 7], [OTHER, 1]]);
    expect(buildInsights(meetings, [...players, third], filters({ rivalTag: OTHER })).rivalries.map((entry) => entry.rival.tag)).toEqual([OTHER]);
    expect(JSON.stringify(all.rivalries)).not.toContain(STRANGER);
    const unmet = buildInsights(meetings.slice(6, 7), players, filters({ rivalTag: RIVAL })).rivalries;
    expect(unmet).toMatchObject([{ rival: { tag: RIVAL }, sharedBattles: 0, currentStreak: { kind: "none", length: 0 }, recentMeetings: [] }]);
  });
});

describe("deck builder statistics", () => {
  const evolved = [card(1, { form: "evolution" }), ...OWN.slice(1)];
  const battles = [
    duel(0, "win", deck(101)),
    duel(60, "loss", deck(101), {}, { cards: [...evolved].reverse() }),
    duel(120, "loss", deck(101), mirror),
    duel(180, "win", deck(101), { unit: "duel_round" }),
    game("2026-09-08T20:00:00.000Z", [side(ME, 0, "win", deck(11)), side(RIVAL, 0, "win", deck(51)), side(STRANGER, 1, "loss", deck(101)), side(OTHER, 1, "loss", deck(101, { form: "evolution" }))]),
  ];

  it("collapses a card's forms by id without double-counting a battle", () => {
    const stats = buildCardStats(battles, ME);
    expect(stats.baseline).toMatchObject({ games: 3, wins: 2, losses: 1 });
    expect(stats.cards["1"]).toMatchObject({ id: 1, key: "card-1", name: "Card 1", with: { games: 2, wins: 1, losses: 1 }, against: { games: 0 } });
    expect(stats.cards["1"]!.forms.map((entry) => [entry.form, entry.with.games]).sort()).toEqual([["base", 1], ["evolution", 1]]);
    expect(stats.cards["1"]!.withDelta).toBeCloseTo(0.5 - 2 / 3);
    expect(stats.cards["101"]!.against).toMatchObject({ games: 3, wins: 2, losses: 1 });
    expect(stats.cards["101"]!.forms.map((entry) => [entry.form, entry.against.games]).sort()).toEqual([["base", 3], ["evolution", 1]]);
  });

  it("finds one exact eight-card set whatever the forms or order, split by deck origin", () => {
    const record = buildDeckRecord(battles, ME, [8, 7, 6, 5, 4, 3, 2, 1]);
    expect(record).toMatchObject({ cardIds: [1, 2, 3, 4, 5, 6, 7, 8], chosen: { games: 2, wins: 1, losses: 1, winRate: 0.5 }, assigned: { games: 1, losses: 1 } });
    expect(record.recent.map((entry) => [entry.result, entry.origin, entry.modeName])).toEqual([["loss", "assigned", "MirrorDeck_Friendly"], ["loss", "chosen", "Ladder"], ["win", "chosen", "Ladder"]]);
    expect(buildDeckRecord(battles, ME, [1, 2, 3, 4, 5, 6, 7, 9])).toMatchObject({ chosen: { games: 0, winRate: null }, assigned: { games: 0 }, recent: [] });
  });
});
