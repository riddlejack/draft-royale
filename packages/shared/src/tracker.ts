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
