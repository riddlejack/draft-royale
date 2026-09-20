export type TrackerBattleSource = "api" | "manual";
export type TrackerBattleResult = "win" | "loss" | "draw" | "unknown";
export type TrackerCardForm = "base" | "evolution" | "hero" | "heroEvolution" | "champion";

export interface TrackerPlayer {
  profileId: string;
  displayName: string;
  tag: string;
}

export interface TrackerCard {
  id: number | null;
  key: string;
  name: string;
  form: TrackerCardForm;
  elixirCost: number | null;
}

export interface TrackerParticipant {
  profileId: string | null;
  tag: string;
  name: string;
  side: 0 | 1;
  crowns: number | null;
  result: TrackerBattleResult;
  elixirLeaked: number | null;
  cards: TrackerCard[];
}

export interface TrackerBattle {
  id: string;
  battleTime: string;
  type: string;
  mode: { id: number | null; name: string };
  source: TrackerBattleSource;
  fetchedAt: number;
  participants: TrackerParticipant[];
}

export interface TrackerTally {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  unknown: number;
  winRate: number | null;
}

export interface TrackerPlayerTally extends TrackerTally {
  profileId: string;
  displayName: string;
  tag: string;
}

export interface TrackerPairTally extends TrackerTally {
  leftProfileId: string;
  leftDisplayName: string;
  rightProfileId: string;
  rightDisplayName: string;
}

export interface TrackerModeTally extends TrackerTally {
  profileId: string;
  modeId: number | null;
  modeName: string;
}

export interface TrackerCardTally extends TrackerTally {
  profileId: string;
  card: TrackerCard;
}

export interface TrackerDeckTally extends TrackerTally {
  profileId: string;
  signature: string;
  cards: TrackerCard[];
}

export interface TrackerPollPlayerStatus {
  profileId: string;
  displayName: string;
  tag: string;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  battlesSeen: number;
}

export interface TrackerPollStatus {
  configured: boolean;
  state: "ready" | "missing_token" | "polling" | "backoff" | "closed";
  lastPollAt: number | null;
  lastSuccessfulPollAt: number | null;
  nextPollAt: number | null;
  stale: boolean;
  message: string;
  players: TrackerPollPlayerStatus[];
}

export interface TrackerSummary {
  generatedAt: number;
  scope: "rolling_observations";
  completenessNotice: string;
  poll: TrackerPollStatus;
  players: TrackerPlayerTally[];
  headToHead: TrackerPairTally[];
  coPlay: TrackerPairTally[];
  modes: TrackerModeTally[];
  cards: TrackerCardTally[];
  decks: TrackerDeckTally[];
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
