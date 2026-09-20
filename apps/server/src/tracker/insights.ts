import type {
  TrackerBattle,
  TrackerBattleResult,
  TrackerCard,
  TrackerCardInsight,
  TrackerCardStat,
  TrackerCardStats,
  TrackerCardTally,
  TrackerDeckOrigin,
  TrackerDeckRecord,
  TrackerDuoDeckTally,
  TrackerElixirLeakInsight,
  TrackerInsightBucket,
  TrackerInsights,
  TrackerInsightsFilters,
  TrackerLevelGapInsight,
  TrackerMatchupInsight,
  TrackerMonthTally,
  TrackerParticipant,
  TrackerPlayer,
  TrackerRateInterval,
  TrackerRivalry,
  TrackerRivalryDeckTally,
  TrackerRivalryMeeting,
  TrackerRivalryModeTally,
  TrackerStreak,
  TrackerTally,
  TrackerTiltInsight,
  TrackerTimeInsight,
  TrackerTowerTroopTally,
  TrackerTrophyPoint,
  TrackerTrophySeries,
} from "@draft-royale/shared";
import { addResult, bareCard, deckOriginOf, deckSignature, emptyTally, finalizeTally } from "./tally.js";

const SESSION_GAP_MINUTES = 30;
export const RANKING_MIN_DECIDED = 5;
const MAX_RANKED_CARDS = 12;
const MAX_TROPHY_POINTS = 500;
const MAX_RECENT_MEETINGS = 25;
const WILSON_Z = 1.96;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** One battle from the focus player's side. `hasDeck` excludes duels, whose rows list every round's cards together. */
interface FocusRow {
  battle: TrackerBattle;
  focus: TrackerParticipant;
  opponents: TrackerParticipant[];
  ms: number;
  origin: TrackerDeckOrigin;
  hasDeck: boolean;
  counted: boolean;
}

export const trackerModeKey = (mode: TrackerBattle["mode"]) => `${mode.id ?? "name"}:${mode.name}`;
const cardFormKey = (card: TrackerCard) => `${card.id ?? card.key}:${card.form}`;
const cardIdKey = (card: TrackerCard) => `${card.id ?? card.key}`;
const decidedGames = (tally: TrackerTally) => tally.wins + tally.losses + tally.draws;
const byGames = <T extends TrackerTally>(left: T, right: T) => right.games - left.games || right.losses - left.losses;
const rateDelta = (tally: TrackerTally, baseline: TrackerTally) => tally.winRate === null || baseline.winRate === null ? null : tally.winRate - baseline.winRate;
const bump = <T extends TrackerTally>(map: Map<string, T>, key: string, create: () => T, result: TrackerBattleResult) => {
  let tally = map.get(key);
  if (!tally) { tally = create(); map.set(key, tally); }
  addResult(tally, result);
};
const bucket = (key: string, label: string, min: number | null, max: number | null): TrackerInsightBucket => ({ key, label, min, max, ...emptyTally() });
const isOneVsOne = (row: FocusRow) => row.battle.participants.length === 2 && row.opponents.length === 1;

export const wilsonInterval = (wins: number, decided: number): TrackerRateInterval | null => {
  if (decided <= 0) return null;
  const rate = wins / decided; const z2 = WILSON_Z * WILSON_Z; const scale = 1 + z2 / decided;
  const centre = (rate + z2 / (2 * decided)) / scale;
  const margin = WILSON_Z * Math.sqrt(rate * (1 - rate) / decided + z2 / (4 * decided * decided)) / scale;
  return { lower: Math.max(0, centre - margin), upper: Math.min(1, centre + margin) };
};

const focusRows = (battles: TrackerBattle[], playerTag: string): FocusRow[] => {
  const rows: FocusRow[] = [];
  for (const battle of battles) {
    const focus = battle.participants.find((participant) => participant.tag === playerTag);
    if (!focus) continue;
    rows.push({
      battle, focus, opponents: battle.participants.filter((participant) => participant.side !== focus.side), ms: Date.parse(battle.battleTime),
      origin: deckOriginOf(battle.deckSelection, battle.mode.name).origin, hasDeck: battle.unit === "match" && focus.cards.length === 8, counted: true,
    });
  }
  return rows.sort((left, right) => left.ms - right.ms || left.battle.id.localeCompare(right.battle.id));
};

interface CardRecord { card: TrackerCard; withCard: TrackerTally; againstCard: TrackerTally }
// A 2v2 can show the same card in both opposing decks; it still counts as one game against that card.
const tallyCards = (rows: FocusRow[], keyOf: (card: TrackerCard) => string) => {
  const records = new Map<string, CardRecord>();
  const record = (card: TrackerCard) => {
    const key = keyOf(card);
    let current = records.get(key);
    if (!current) { current = { card: bareCard(card), withCard: emptyTally(), againstCard: emptyTally() }; records.set(key, current); }
    return current;
  };
  for (const { focus, opponents } of rows) {
    for (const card of focus.cards) addResult(record(card).withCard, focus.result);
    const faced = new Set<string>();
    for (const opponent of opponents) if (opponent.cards.length === 8) for (const card of opponent.cards) {
      const key = keyOf(card);
      if (faced.has(key)) continue;
      faced.add(key); addResult(record(card).againstCard, focus.result);
    }
  }
  for (const current of records.values()) { finalizeTally(current.withCard); finalizeTally(current.againstCard); }
  return records;
};

const cardInsights = (rows: FocusRow[], baseline: TrackerTally) => {
  const cards: TrackerCardInsight[] = [...tallyCards(rows, cardFormKey).values()].map(({ card, withCard, againstCard }) => ({
    card, withCard, againstCard, withDelta: rateDelta(withCard, baseline), againstDelta: rateDelta(againstCard, baseline),
    withInterval: wilsonInterval(withCard.wins, decidedGames(withCard)), againstInterval: wilsonInterval(againstCard.wins, decidedGames(againstCard)),
  })).sort((left, right) => right.againstCard.games + right.withCard.games - left.againstCard.games - left.withCard.games || left.card.name.localeCompare(right.card.name));
  const rankable = cards.filter((card) => decidedGames(card.againstCard) >= RANKING_MIN_DECIDED && card.againstDelta !== null);
  // Ranking by the interval bound nearest the baseline lets a long record outrank a lopsided handful of games.
  const blindSpots = rankable.filter((card) => card.againstDelta! < 0)
    .sort((left, right) => left.againstInterval!.upper - right.againstInterval!.upper || left.againstDelta! - right.againstDelta! || right.againstCard.games - left.againstCard.games).slice(0, MAX_RANKED_CARDS);
  const strengths = rankable.filter((card) => card.againstDelta! > 0)
    .sort((left, right) => right.againstInterval!.lower - left.againstInterval!.lower || right.againstDelta! - left.againstDelta! || right.againstCard.games - left.againstCard.games).slice(0, MAX_RANKED_CARDS);
  return { cards, blindSpots, strengths };
};

const levelDeficit = (cards: TrackerCard[]) => {
  let total = 0;
  for (const card of cards) {
    if (typeof card.level !== "number" || typeof card.maxLevel !== "number") return null;
    total += card.maxLevel - card.level;
  }
  return total / cards.length;
};
const levelGapInsight = (rows: FocusRow[]): TrackerLevelGapInsight => {
  const buckets = [
    bucket("ahead_major", "1+ levels ahead", null, -1), bucket("ahead_minor", "Slightly ahead", -1, -0.25), bucket("even", "Even", -0.25, 0.25),
    bucket("behind_minor", "Slightly behind", 0.25, 1), bucket("behind_major", "1+ levels behind", 1, null),
  ];
  let battles = 0; let total = 0;
  for (const row of rows) {
    if (!isOneVsOne(row) || row.opponents[0]!.cards.length !== 8) continue;
    const own = levelDeficit(row.focus.cards); const other = levelDeficit(row.opponents[0]!.cards);
    if (own === null || other === null) continue;
    const gap = own - other;
    battles += 1; total += gap;
    addResult(buckets[gap <= -1 ? 0 : gap < -0.25 ? 1 : gap <= 0.25 ? 2 : gap < 1 ? 3 : 4]!, row.focus.result);
  }
  return { battles, meanGap: battles ? total / battles : null, buckets: buckets.map(finalizeTally) };
};

const trophyTimeline = (rows: FocusRow[]): TrackerTrophySeries[] => {
  const points: TrackerTrophyPoint[] = [];
  for (const { battle, focus } of rows) {
    if (typeof focus.startingTrophies !== "number" || typeof focus.trophyChange !== "number") continue;
    points.push({ battleId: battle.id, battleTime: battle.battleTime, trophies: focus.startingTrophies + focus.trophyChange, change: focus.trophyChange, modeName: battle.mode.name, type: battle.type });
  }
  const series = new Map<string, TrackerTrophySeries>();
  for (const point of points.slice(-MAX_TROPHY_POINTS)) {
    const current = series.get(point.type) ?? { type: point.type, points: [] };
    current.points.push(point); series.set(point.type, current);
  }
  return [...series.values()].sort((left, right) => right.points.length - left.points.length);
};

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right); const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
// Sessions and loss runs come from every battle so a filtered mode still sees the losses that preceded it.
const tiltInsight = (rows: FocusRow[]): TrackerTiltInsight => {
  const byPriorLosses = [bucket("0", "No loss before", 0, 0), bucket("1", "After 1 loss", 1, 1), bucket("2", "After 2 losses", 2, 2), bucket("3+", "After 3+ losses", 3, null)];
  const byPosition = [bucket("1-3", "Games 1–3", 1, 3), bucket("4-6", "Games 4–6", 4, 6), bucket("7-10", "Games 7–10", 7, 10), bucket("11+", "Game 11 onwards", 11, null)];
  const lengths: number[] = [];
  let lastMs = Number.NEGATIVE_INFINITY; let position = 0; let lossRun = 0; let sessionCounted = false;
  for (const row of rows) {
    if (row.ms - lastMs > SESSION_GAP_MINUTES * 60_000) {
      if (sessionCounted) lengths.push(position);
      position = 0; lossRun = 0; sessionCounted = false;
    }
    position += 1; lastMs = row.ms;
    if (row.counted) {
      sessionCounted = true;
      addResult(byPriorLosses[Math.min(lossRun, 3)]!, row.focus.result);
      addResult(byPosition[position <= 3 ? 0 : position <= 6 ? 1 : position <= 10 ? 2 : 3]!, row.focus.result);
    }
    lossRun = row.focus.result === "loss" ? lossRun + 1 : 0;
  }
  if (sessionCounted) lengths.push(position);
  return { sessionGapMinutes: SESSION_GAP_MINUTES, sessionCount: lengths.length, medianSessionLength: median(lengths), byPriorLosses: byPriorLosses.map(finalizeTally), byPosition: byPosition.map(finalizeTally) };
};

const timeInsight = (rows: FocusRow[], tzMs: number): TrackerTimeInsight => {
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, ...emptyTally() }));
  const byWeekday = WEEKDAYS.map((label, weekday) => ({ weekday, label, ...emptyTally() }));
  for (const row of rows) {
    const local = new Date(row.ms + tzMs);
    addResult(byHour[local.getUTCHours()]!, row.focus.result); addResult(byWeekday[local.getUTCDay()]!, row.focus.result);
  }
  return { byHour: byHour.map(finalizeTally), byWeekday: byWeekday.map(finalizeTally) };
};

const elixirLeakInsight = (rows: FocusRow[]): TrackerElixirLeakInsight => {
  const totals = { win: { games: 0, leaked: 0 }, loss: { games: 0, leaked: 0 } };
  for (const row of rows) {
    const { result, elixirLeaked } = row.focus;
    // Boosted-elixir modes (7x, triple, infinite) leak several times more and would swamp the normal-mode average.
    if (!isOneVsOne(row) || /elixir/i.test(row.battle.mode.name) || elixirLeaked === null || (result !== "win" && result !== "loss")) continue;
    totals[result].games += 1; totals[result].leaked += elixirLeaked;
  }
  const stat = ({ games, leaked }: { games: number; leaked: number }) => ({ games, meanLeaked: games ? leaked / games : null });
  return { wins: stat(totals.win), losses: stat(totals.loss) };
};

const matchupInsight = (rows: FocusRow[]): TrackerMatchupInsight => {
  const bands = [bucket("lt3.0", "Under 3.0", null, 3), bucket("3.0-3.5", "3.0–3.5", 3, 3.5), bucket("3.5-4.0", "3.5–4.0", 3.5, 4), bucket("4.0-4.5", "4.0–4.5", 4, 4.5), bucket("gte4.5", "4.5 and up", 4.5, null)];
  const towerTroops = new Map<string, TrackerTowerTroopTally>();
  for (const { focus, opponents } of rows) {
    const facedBands = new Set<number>(); const facedTroops = new Set<string>();
    for (const opponent of opponents) {
      if (opponent.cards.length === 8 && opponent.cards.every((card) => card.elixirCost !== null)) {
        const average = opponent.cards.reduce((sum, card) => sum + card.elixirCost!, 0) / 8;
        facedBands.add(average < 3 ? 0 : average < 3.5 ? 1 : average < 4 ? 2 : average < 4.5 ? 3 : 4);
      }
      const troop = opponent.supportCards?.[0];
      if (troop && !facedTroops.has(cardIdKey(troop))) { facedTroops.add(cardIdKey(troop)); bump(towerTroops, cardIdKey(troop), () => ({ card: bareCard(troop), ...emptyTally() }), focus.result); }
    }
    for (const index of facedBands) addResult(bands[index]!, focus.result);
  }
  return { byElixirBand: bands.map(finalizeTally), byTowerTroop: [...towerTroops.values()].map(finalizeTally).sort(byGames) };
};

interface RivalryDraft {
  rivalry: TrackerRivalry;
  run: TrackerStreak;
  versusByMode: Map<string, TrackerRivalryModeTally>;
  versusByMonth: Map<string, TrackerMonthTally>;
  alongsideByMode: Map<string, TrackerRivalryModeTally>;
  ownDecks: Map<string, TrackerRivalryDeckTally>;
  rivalDecks: Map<string, TrackerRivalryDeckTally>;
  rivalCards: Map<string, TrackerCardTally>;
  duoDecks: Map<string, TrackerDuoDeckTally>;
}
const rivalryDraft = (rival: TrackerPlayer): RivalryDraft => ({
  rivalry: {
    rival, sharedBattles: 0, versus: emptyTally(), versusChosen: emptyTally(), versusAssigned: emptyTally(), versusByMode: [], versusByMonth: [], currentStreak: { kind: "none", length: 0 },
    longestWinStreak: 0, longestLossStreak: 0, crownGames: 0, crownsFor: 0, crownsAgainst: 0, threeCrownWins: 0, threeCrownLosses: 0, ownDecks: [], rivalDecks: [], rivalCards: [], recentMeetings: [],
    alongside: { tally: emptyTally(), byMode: [], duoDecks: [] },
  },
  run: { kind: "none", length: 0 }, versusByMode: new Map(), versusByMonth: new Map(), alongsideByMode: new Map(), ownDecks: new Map(), rivalDecks: new Map(), rivalCards: new Map(), duoDecks: new Map(),
});

// Rows arrive oldest first, which is what the streaks and the recent-meeting tail rely on.
const rivalryInsights = (rows: FocusRow[], players: TrackerPlayer[], filters: TrackerInsightsFilters, tzMs: number): TrackerRivalry[] => {
  const playerTag = filters.playerTag;
  const rivals = new Map(players.filter((player) => player.tag !== playerTag && (!filters.rivalTag || player.tag === filters.rivalTag)).map((player) => [player.tag, player]));
  const drafts = new Map<string, RivalryDraft>();
  const selected = filters.rivalTag ? rivals.get(filters.rivalTag) : undefined;
  if (selected) drafts.set(selected.tag, rivalryDraft(selected));
  const deckTally = (map: Map<string, TrackerRivalryDeckTally>, cards: TrackerCard[], origin: TrackerDeckOrigin, result: TrackerBattleResult) => {
    const signature = deckSignature(cards);
    bump(map, `${origin} ${signature}`, () => ({ playerTag, signature, cards: cards.map(bareCard), origin, ...emptyTally() }), result);
  };
  for (const { battle, focus, ms, origin } of rows) for (const other of battle.participants) {
    const rival = rivals.get(other.tag);
    if (!rival) continue;
    let draft = drafts.get(rival.tag);
    if (!draft) { draft = rivalryDraft(rival); drafts.set(rival.tag, draft); }
    const { rivalry } = draft; const result = focus.result;
    const modeKey = trackerModeKey(battle.mode);
    const modeTally = (): TrackerRivalryModeTally => ({ playerTag, modeId: battle.mode.id, modeName: battle.mode.name, modeKey, ...emptyTally() });
    const deckBattle = battle.unit === "match" && (filters.includeAssigned || origin === "chosen");
    if (other.side === focus.side) {
      addResult(rivalry.alongside.tally, result); bump(draft.alongsideByMode, modeKey, modeTally, result);
      if (deckBattle && focus.cards.length === 8 && other.cards.length === 8) {
        const ownSignature = deckSignature(focus.cards); const partnerSignature = deckSignature(other.cards);
        bump(draft.duoDecks, `${ownSignature} ${partnerSignature}`, () => ({ ownSignature, ownCards: focus.cards.map(bareCard), partnerSignature, partnerCards: other.cards.map(bareCard), ...emptyTally() }), result);
      }
      continue;
    }
    addResult(rivalry.versus, result); addResult(origin === "chosen" ? rivalry.versusChosen : rivalry.versusAssigned, result);
    bump(draft.versusByMode, modeKey, modeTally, result);
    const month = new Date(ms + tzMs).toISOString().slice(0, 7);
    bump(draft.versusByMonth, month, () => ({ month, ...emptyTally() }), result);
    draft.run = result === "win" || result === "loss" ? { kind: result, length: draft.run.kind === result ? draft.run.length + 1 : 1 } : { kind: "none", length: 0 };
    if (draft.run.kind === "win") rivalry.longestWinStreak = Math.max(rivalry.longestWinStreak, draft.run.length);
    if (draft.run.kind === "loss") rivalry.longestLossStreak = Math.max(rivalry.longestLossStreak, draft.run.length);
    if (focus.crowns !== null && other.crowns !== null) { rivalry.crownGames += 1; rivalry.crownsFor += focus.crowns; rivalry.crownsAgainst += other.crowns; }
    if (result === "win" && focus.crowns === 3) rivalry.threeCrownWins += 1;
    if (result === "loss" && other.crowns === 3) rivalry.threeCrownLosses += 1;
    if (deckBattle && focus.cards.length === 8) deckTally(draft.ownDecks, focus.cards, origin, result);
    if (deckBattle && other.cards.length === 8) {
      deckTally(draft.rivalDecks, other.cards, origin, result);
      for (const card of other.cards) bump(draft.rivalCards, cardFormKey(card), () => ({ playerTag, card: bareCard(card), ...emptyTally() }), result);
    }
    rivalry.recentMeetings.push({ battleId: battle.id, battleTime: battle.battleTime, modeName: battle.mode.name, type: battle.type, unit: battle.unit, deckSelection: battle.deckSelection ?? null, deckOrigin: origin, result, crownsFor: focus.crowns, crownsAgainst: other.crowns } satisfies TrackerRivalryMeeting);
  }
  const top = <T extends TrackerTally>(map: Map<string, T>, limit: number) => [...map.values()].map(finalizeTally).sort(byGames).slice(0, limit);
  return [...drafts.values()].map((draft): TrackerRivalry => ({
    ...draft.rivalry, sharedBattles: draft.rivalry.versus.games + draft.rivalry.alongside.tally.games,
    versus: finalizeTally(draft.rivalry.versus), versusChosen: finalizeTally(draft.rivalry.versusChosen), versusAssigned: finalizeTally(draft.rivalry.versusAssigned),
    versusByMode: top(draft.versusByMode, Number.POSITIVE_INFINITY), versusByMonth: [...draft.versusByMonth.values()].map(finalizeTally).sort((left, right) => left.month.localeCompare(right.month)),
    currentStreak: draft.run, ownDecks: top(draft.ownDecks, 10), rivalDecks: top(draft.rivalDecks, 10), rivalCards: top(draft.rivalCards, 20),
    recentMeetings: draft.rivalry.recentMeetings.slice(-MAX_RECENT_MEETINGS).reverse(),
    alongside: { tally: finalizeTally(draft.rivalry.alongside.tally), byMode: top(draft.alongsideByMode, Number.POSITIVE_INFINITY), duoDecks: top(draft.duoDecks, 8) },
  })).sort((left, right) => right.sharedBattles - left.sharedBattles || left.rival.displayName.localeCompare(right.rival.displayName));
};

const tallyOf = (rows: FocusRow[]) => {
  const tally = emptyTally();
  for (const row of rows) addResult(tally, row.focus.result);
  return finalizeTally(tally);
};

/** `filters` must already be normalized against `players`: both tags visible, the rival distinct from the focus player. */
export const buildInsights = (battles: TrackerBattle[], players: TrackerPlayer[], filters: TrackerInsightsFilters): Omit<TrackerInsights, "generatedAt" | "completenessNotice"> => {
  const rows = focusRows(battles, filters.playerTag);
  const startMs = filters.dateFrom ? Date.parse(`${filters.dateFrom}T00:00:00.000Z`) : Number.NEGATIVE_INFINITY;
  const endMs = filters.dateTo ? Date.parse(`${filters.dateTo}T23:59:59.999Z`) : Number.POSITIVE_INFINITY;
  const tzMs = filters.tzOffsetMinutes * 60_000;
  const modeOptions = new Map<string, string>();
  for (const row of rows) {
    const modeKey = trackerModeKey(row.battle.mode);
    modeOptions.set(modeKey, row.battle.mode.name);
    row.counted = row.ms >= startMs && row.ms <= endMs && (!filters.mode || filters.mode === modeKey);
  }
  const counted = rows.filter((row) => row.counted);
  const skill = counted.filter((row) => row.hasDeck && (filters.includeAssigned || row.origin === "chosen"));
  const baseline = tallyOf(skill);
  return {
    filters, filterOptions: { players, modes: [...modeOptions.entries()].map(([key, name]) => ({ key, name })).sort((left, right) => left.name.localeCompare(right.name)) },
    sample: tallyOf(counted), baseline, ...cardInsights(skill, baseline), rankingMinDecided: RANKING_MIN_DECIDED, levelGap: levelGapInsight(skill), trophyTimeline: trophyTimeline(counted),
    tilt: tiltInsight(rows), time: timeInsight(counted, tzMs), elixirLeaked: elixirLeakInsight(skill), matchups: matchupInsight(skill), rivalries: rivalryInsights(counted, players, filters, tzMs),
  };
};

/** Card insights collapsed across forms. Tallied by card id directly, because summing forms would double-count a 2v2 that faced two forms of one card. */
export const buildCardStats = (battles: TrackerBattle[], playerTag: string): Pick<TrackerCardStats, "baseline" | "cards"> => {
  const rows = focusRows(battles, playerTag).filter((row) => row.hasDeck && row.origin === "chosen");
  const baseline = tallyOf(rows);
  const cards: Record<string, TrackerCardStat> = {};
  for (const [key, { card, withCard, againstCard }] of tallyCards(rows, cardIdKey)) {
    cards[key] = { id: card.id, key: card.key, name: card.name, elixirCost: card.elixirCost, with: withCard, against: againstCard, withDelta: rateDelta(withCard, baseline), againstDelta: rateDelta(againstCard, baseline), forms: [] };
  }
  for (const { card, withCard, againstCard } of tallyCards(rows, cardFormKey).values()) cards[cardIdKey(card)]!.forms.push({ form: card.form, with: withCard, against: againstCard });
  return { baseline, cards };
};

/** `cardIds` must be eight distinct ids. Forms and order are ignored, so an evolved and a base copy of a card are the same deck here. */
export const buildDeckRecord = (battles: TrackerBattle[], playerTag: string, cardIds: readonly number[]): Pick<TrackerDeckRecord, "cardIds" | "chosen" | "assigned" | "recent"> => {
  const wanted = new Set(cardIds);
  const record = { chosen: emptyTally(), assigned: emptyTally() };
  const matches = focusRows(battles, playerTag).filter((row) => row.hasDeck && new Set(row.focus.cards.map((card) => card.id)).size === 8 && row.focus.cards.every((card) => card.id !== null && wanted.has(card.id)));
  for (const row of matches) addResult(record[row.origin], row.focus.result);
  return {
    cardIds: [...cardIds].sort((left, right) => left - right), chosen: finalizeTally(record.chosen), assigned: finalizeTally(record.assigned),
    recent: matches.slice(-5).reverse().map((row) => ({ battleTime: row.battle.battleTime, modeName: row.battle.mode.name, result: row.focus.result, origin: row.origin })),
  };
};
