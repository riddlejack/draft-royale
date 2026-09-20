export type TrackerBattleSource = "api" | "manual";
export type TrackerBattleResult = "win" | "loss" | "draw" | "unknown";
export type TrackerBattleUnit = "match" | "duel_round";
export type TrackerCardForm = "base" | "evolution" | "hero" | "heroEvolution" | "champion";
export type TrackerRelationship = "all" | "versus" | "alongside";

export interface TrackerPlayer {
  tag: string;
  displayName: string;
  linkedProfileIds: string[];
  activeProfileIds: string[];
}

export interface TrackerCard {
  id: number | null;
  key: string;
  name: string;
  form: TrackerCardForm;
  elixirCost: number | null;
  /** Rarity-relative API level and its cap. Absent on rows recorded before full battle detail was kept. */
  level?: number | null;
  maxLevel?: number | null;
}

/** How the game assigned a deck: "chosen" decks were built by the player; "assigned" covers mirror, draft, pick and event decks. */
export type TrackerDeckOrigin = "chosen" | "assigned";

export interface TrackerParticipant {
  /** Present only for manual results so social identity survives a later tag change. */
  profileId: string | null;
  tag: string;
  name: string;
  side: 0 | 1;
  crowns: number | null;
  result: TrackerBattleResult;
  elixirLeaked: number | null;
  cards: TrackerCard[];
  startingTrophies?: number | null;
  trophyChange?: number | null;
  kingTowerHitPoints?: number | null;
  princessTowersHitPoints?: number[] | null;
  clan?: { tag: string; name: string } | null;
  globalRank?: number | null;
  supportCards?: TrackerCard[];
}

export interface TrackerBattleProvenance {
  kind: "server_fetch" | "operator_snapshot" | "user_import" | "manual";
  label: string;
  observedAt: number;
}

export interface TrackerBattle {
  id: string;
  battleTime: string;
  type: string;
  mode: { id: number | null; name: string };
  source: TrackerBattleSource;
  unit: TrackerBattleUnit;
  fetchedAt: number;
  provenance: TrackerBattleProvenance;
  participants: TrackerParticipant[];
  /** Raw API deckSelection ("collection", "predefined", "draft", "pick", …). Null on rows recorded before it was kept. */
  deckSelection?: string | null;
  arena?: { id: number | null; name: string } | null;
  leagueNumber?: number | null;
  isLadderTournament?: boolean | null;
  isHostedMatch?: boolean | null;
  eventTag?: string | null;
  tournamentTag?: string | null;
}

export interface TrackerTally {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  unknown: number;
  winRate: number | null;
}

export interface TrackerPlayerTally extends TrackerTally, TrackerPlayer {}

export interface TrackerPairTally extends TrackerTally {
  leftTag: string;
  leftDisplayName: string;
  rightTag: string;
  rightDisplayName: string;
}

export interface TrackerModeTally extends TrackerTally {
  playerTag: string;
  modeId: number | null;
  modeName: string;
}

export interface TrackerCardTally extends TrackerTally {
  playerTag: string;
  card: TrackerCard;
}

export interface TrackerDeckTally extends TrackerTally {
  playerTag: string;
  signature: string;
  cards: TrackerCard[];
}

export interface TrackerDeckMatchupTally extends TrackerTally {
  playerTag: string;
  ownSignature: string;
  ownCards: TrackerCard[];
  opponentSignature: string;
  opponentCards: TrackerCard[];
}

export interface TrackerPollPlayerStatus {
  displayName: string;
  tag: string;
  subscriberCount: number;
  trackingStartedAt: number;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextPollAt: number | null;
  lastError: string | null;
  battlesSeen: number;
  consecutiveFailures: number;
  idleStreak: number;
  possibleGapCount: number;
}

export interface TrackerPollStatus {
  configured: boolean;
  state: "ready" | "missing_token" | "polling" | "backoff" | "closed";
  lastPollAt: number | null;
  lastSuccessfulPollAt: number | null;
  nextPollAt: number | null;
  stale: boolean;
  message: string;
  requestBudget: {
    trackedTags: number;
    quickPollRequestsPerDay: number;
    maximumIdleRequestsPerDay: number;
  };
  players: TrackerPollPlayerStatus[];
}

export interface TrackerCoverageGap {
  startAt: string;
  endAt: string;
  detectedAt: number;
  reason: "non_overlapping_api_windows";
}

export interface TrackerCoverage {
  playerTag: string;
  trackingStartedAt: number | null;
  earliestBattleAt: string | null;
  latestBattleAt: string | null;
  lastSuccessfulSyncAt: number | null;
  possibleGaps: TrackerCoverageGap[];
  sourceCounts: Record<TrackerBattleSource, number>;
  provenanceCounts: {
    serverFetch: number;
    operatorSnapshot: number;
    userImport: number;
    manual: number;
  };
}

export interface TrackerDeckLogMode extends TrackerTally {
  modeId: number | null;
  modeName: string;
  type: string;
}

/** One distinct eight-card deck a player has been observed using, aggregated across every recorded battle. */
export interface TrackerDeckLogEntry extends TrackerTally {
  signature: string;
  cards: TrackerCard[];
  towerTroop: TrackerCard | null;
  origin: TrackerDeckOrigin;
  /** True when no battle for this deck recorded deckSelection, so origin was inferred from the mode name. */
  originInferred: boolean;
  deckSelections: string[];
  firstUsedAt: string;
  lastUsedAt: string;
  averageElixir: number | null;
  modes: TrackerDeckLogMode[];
}

export interface TrackerDeckLog {
  generatedAt: number;
  playerTag: string;
  players: TrackerPlayer[];
  battlesWithDecks: number;
  decks: TrackerDeckLogEntry[];
}

export interface TrackerDeckLogResponse {
  deckLog: TrackerDeckLog;
}

/** Compares the profile's lifetime counters with recorded battles between the first and last profile snapshot. */
export interface TrackerBattleCountAudit {
  playerTag: string;
  fromAt: number | null;
  toAt: number | null;
  battleCountDelta: number | null;
  winsDelta: number | null;
  lossesDelta: number | null;
  recordedByType: Array<{ type: string; games: number }>;
}

export interface TrackerFilters {
  playerTag: string;
  opponentTag: string | null;
  relationship: TrackerRelationship;
  mode: string | null;
  dateFrom: string | null;
  dateTo: string | null;
}

export interface TrackerFilterOptions {
  players: TrackerPlayer[];
  modes: Array<{ key: string; name: string }>;
}

export interface TrackerSummary {
  generatedAt: number;
  scope: "rolling_observations";
  completenessNotice: string;
  poll: TrackerPollStatus;
  filters: TrackerFilters;
  filterOptions: TrackerFilterOptions;
  coverage: TrackerCoverage | null;
  sample: TrackerTally;
  players: TrackerPlayerTally[];
  headToHead: TrackerPairTally[];
  coPlay: TrackerPairTally[];
  modes: TrackerModeTally[];
  cards: TrackerCardTally[];
  decks: TrackerDeckTally[];
  opponentCards: TrackerCardTally[];
  opponentDecks: TrackerDeckTally[];
  deckMatchups: TrackerDeckMatchupTally[];
  recentGames: TrackerBattle[];
}

export interface TrackerSummaryResponse {
  summary: TrackerSummary;
}

export interface ManualTrackerResultInput {
  commandId: string;
  battleTime?: string;
  type?: string;
  mode?: { id?: number; name: string };
  teamAProfileIds: string[];
  teamBProfileIds: string[];
  winner: "a" | "b" | "draw" | "unknown";
  crownsA?: number;
  crownsB?: number;
}

export interface UndoManualTrackerResultInput {
  commandId: string;
}

export interface ManualTrackerResultResponse {
  battle: TrackerBattle;
  replayed: boolean;
}

export interface UndoManualTrackerResultResponse {
  battleId: string;
  undone: boolean;
  replayed: boolean;
}

export interface TrackerImportResult {
  inputRows: number;
  validRows: number;
  uniqueRows: number;
  insertedRows: number;
  duplicateRows: number;
  rejectedRows: number;
  earliestBattleAt: string | null;
  latestBattleAt: string | null;
  provenanceKind: "operator_snapshot" | "user_import";
}

export interface TrackerInsightsFilters {
  playerTag: string;
  rivalTag: string | null;
  mode: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  /** Card, deck, level, elixir and matchup insights count only decks the player built unless this is set. Results-only insights always count every battle. */
  includeAssigned: boolean;
  /** Minutes added to UTC to reach the viewer's local time; drives hour, weekday and month buckets. */
  tzOffsetMinutes: number;
}

/** Wilson 95% score interval for a win rate over decided games (wins + losses + draws). */
export interface TrackerRateInterval {
  lower: number;
  upper: number;
}

export interface TrackerCardInsight {
  card: TrackerCard;
  /** The focus player's record when their own deck held this card. */
  withCard: TrackerTally;
  /** The focus player's record when an opposing deck held this card, counted once per battle. */
  againstCard: TrackerTally;
  /** Win rate minus the baseline win rate; null when either side has no decided game. */
  withDelta: number | null;
  againstDelta: number | null;
  withInterval: TrackerRateInterval | null;
  againstInterval: TrackerRateInterval | null;
}

/** A numeric range with its record. `min` and `max` are the range's display bounds; null means unbounded. */
export interface TrackerInsightBucket extends TrackerTally {
  key: string;
  label: string;
  min: number | null;
  max: number | null;
}

/** Gap = the focus deck's mean (maxLevel - level) minus the opponent's, so a positive gap means the focus player was under-levelled. */
export interface TrackerLevelGapInsight {
  battles: number;
  meanGap: number | null;
  buckets: TrackerInsightBucket[];
}

export interface TrackerTrophyPoint {
  battleId: string;
  battleTime: string;
  trophies: number;
  change: number;
  modeName: string;
  type: string;
}

export interface TrackerTrophySeries {
  type: string;
  points: TrackerTrophyPoint[];
}

/** Sessions are built from every recorded battle of the focus player; only battles passing the mode and date filters are tallied. */
export interface TrackerTiltInsight {
  sessionGapMinutes: number;
  /** Sessions holding at least one tallied battle, and the median number of battles (of any mode) in them. */
  sessionCount: number;
  medianSessionLength: number | null;
  /** Keys "0", "1", "2", "3+": consecutive losses directly before the battle within its session. */
  byPriorLosses: TrackerInsightBucket[];
  /** Keys "1-3", "4-6", "7-10", "11+": the battle's position within its session. */
  byPosition: TrackerInsightBucket[];
}

export interface TrackerHourTally extends TrackerTally {
  hour: number;
}

export interface TrackerWeekdayTally extends TrackerTally {
  /** 0 = Sunday … 6 = Saturday, in the viewer's local time. */
  weekday: number;
  label: string;
}

export interface TrackerTimeInsight {
  byHour: TrackerHourTally[];
  byWeekday: TrackerWeekdayTally[];
}

export interface TrackerElixirLeakStat {
  games: number;
  meanLeaked: number | null;
}

export interface TrackerElixirLeakInsight {
  wins: TrackerElixirLeakStat;
  losses: TrackerElixirLeakStat;
}

export interface TrackerTowerTroopTally extends TrackerTally {
  card: TrackerCard;
}

/** Each battle counts once per band or tower troop it faced, so a 2v2 can appear in two rows. */
export interface TrackerMatchupInsight {
  byElixirBand: TrackerInsightBucket[];
  byTowerTroop: TrackerTowerTroopTally[];
}

export interface TrackerStreak {
  kind: "win" | "loss" | "none";
  length: number;
}

export interface TrackerMonthTally extends TrackerTally {
  /** YYYY-MM in the viewer's local time. */
  month: string;
}

export interface TrackerRivalryModeTally extends TrackerModeTally {
  /** Same key format as TrackerFilterOptions.modes, so a row can become a mode filter. */
  modeKey: string;
}

export interface TrackerRivalryDeckTally extends TrackerDeckTally {
  origin: TrackerDeckOrigin;
}

export interface TrackerDuoDeckTally extends TrackerTally {
  ownSignature: string;
  ownCards: TrackerCard[];
  partnerSignature: string;
  partnerCards: TrackerCard[];
}

export interface TrackerRivalryMeeting {
  battleId: string;
  battleTime: string;
  modeName: string;
  type: string;
  unit: TrackerBattleUnit;
  deckSelection: string | null;
  deckOrigin: TrackerDeckOrigin;
  result: TrackerBattleResult;
  crownsFor: number | null;
  crownsAgainst: number | null;
}

export interface TrackerRivalryAlongside {
  tally: TrackerTally;
  byMode: TrackerRivalryModeTally[];
  duoDecks: TrackerDuoDeckTally[];
}

/** Every tally is the focus player's result. Results count every deck origin; the deck and card lists follow `includeAssigned`. */
export interface TrackerRivalry {
  rival: TrackerPlayer;
  sharedBattles: number;
  versus: TrackerTally;
  versusChosen: TrackerTally;
  versusAssigned: TrackerTally;
  versusByMode: TrackerRivalryModeTally[];
  versusByMonth: TrackerMonthTally[];
  currentStreak: TrackerStreak;
  longestWinStreak: number;
  longestLossStreak: number;
  /** Crown totals cover only the `crownGames` meetings where both crown counts were recorded. */
  crownGames: number;
  crownsFor: number;
  crownsAgainst: number;
  threeCrownWins: number;
  threeCrownLosses: number;
  ownDecks: TrackerRivalryDeckTally[];
  rivalDecks: TrackerRivalryDeckTally[];
  rivalCards: TrackerCardTally[];
  recentMeetings: TrackerRivalryMeeting[];
  alongside: TrackerRivalryAlongside;
}

export interface TrackerInsights {
  generatedAt: number;
  completenessNotice: string;
  filters: TrackerInsightsFilters;
  filterOptions: TrackerFilterOptions;
  /** Every battle passing the mode and date filters; the base for trophies, tilt, time and rivalries. */
  sample: TrackerTally;
  /** Non-duel battles with an eight-card deck the player built (or any origin with includeAssigned); the base for cards, level gap, elixir and matchups. */
  baseline: TrackerTally;
  cards: TrackerCardInsight[];
  /** Cards need this many decided games against them to rank as a blind spot or strength. */
  rankingMinDecided: number;
  /** Below-baseline cards, ordered by the Wilson upper bound so small samples sink. */
  blindSpots: TrackerCardInsight[];
  /** Above-baseline cards, ordered by the Wilson lower bound. */
  strengths: TrackerCardInsight[];
  levelGap: TrackerLevelGapInsight;
  trophyTimeline: TrackerTrophySeries[];
  tilt: TrackerTiltInsight;
  time: TrackerTimeInsight;
  elixirLeaked: TrackerElixirLeakInsight;
  matchups: TrackerMatchupInsight;
  rivalries: TrackerRivalry[];
}

export interface TrackerInsightsResponse {
  insights: TrackerInsights;
}

export interface TrackerCardFormStat {
  form: TrackerCardForm;
  with: TrackerTally;
  against: TrackerTally;
}

/** One card across all of its forms, from battles where the player built the deck. */
export interface TrackerCardStat {
  id: number | null;
  key: string;
  name: string;
  elixirCost: number | null;
  with: TrackerTally;
  against: TrackerTally;
  withDelta: number | null;
  againstDelta: number | null;
  forms: TrackerCardFormStat[];
}

export interface TrackerCardStats {
  generatedAt: number;
  playerTag: string;
  baseline: TrackerTally;
  /** Keyed by card id (or card key when the API gave no id). */
  cards: Record<string, TrackerCardStat>;
}

export interface TrackerCardStatsResponse {
  cardStats: TrackerCardStats;
}

export interface TrackerDeckRecordBattle {
  battleTime: string;
  modeName: string;
  result: TrackerBattleResult;
  origin: TrackerDeckOrigin;
}

/** The record of one exact eight-card set, ignoring card forms and order. */
export interface TrackerDeckRecord {
  generatedAt: number;
  playerTag: string;
  cardIds: number[];
  chosen: TrackerTally;
  assigned: TrackerTally;
  recent: TrackerDeckRecordBattle[];
}

export interface TrackerDeckRecordResponse {
  deckRecord: TrackerDeckRecord;
}
