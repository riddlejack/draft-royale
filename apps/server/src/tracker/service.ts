import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ManualTrackerResultResponse,
  TrackerBattle,
  TrackerBattleProvenance,
  TrackerBattleCountAudit,
  TrackerBattleResult,
  TrackerCard,
  TrackerCardForm,
  TrackerCardStats,
  TrackerCardTally,
  TrackerCoverage,
  TrackerDeckLog,
  TrackerDeckLogEntry,
  TrackerDeckLogMode,
  TrackerDeckMatchupTally,
  TrackerDeckRecord,
  TrackerDeckTally,
  TrackerFilters,
  TrackerImportResult,
  TrackerInsights,
  TrackerInsightsFilters,
  TrackerModeTally,
  TrackerPairTally,
  TrackerParticipant,
  TrackerPlayer,
  TrackerPlayerTally,
  TrackerPollPlayerStatus,
  TrackerPollStatus,
  TrackerRelationship,
  TrackerSummary,
  TrackerTally,
  UndoManualTrackerResultResponse,
} from "@draft-royale/shared";
import { buildCardStats, buildDeckRecord, buildInsights } from "./insights.js";
import { addResult, bareCard, deckOriginOf, deckSignature, emptyTally, finalizeTally } from "./tally.js";

export { deckOriginOf };

const DEFAULT_API_BASE_URL = "https://proxy.royaleapi.dev/v1";
const DEFAULT_QUICK_POLL_MS = 60_000;
const DEFAULT_MAX_IDLE_POLL_MS = 15 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const MAX_API_BODY_BYTES = 5 * 1024 * 1024;
const MAX_RAW_BODY_BYTES = 512 * 1024;
const MAX_BATTLES_PER_RESPONSE = 100;
const MAX_RECENT_BATTLES = 100;
const MANUAL_SYNC_COOLDOWN_MS = 30_000;
const ACTIVE_WINDOW_MS = 10 * 60_000;
const PROFILE_SNAPSHOT_IDLE_MS = 6 * 60 * 60_000;
const MAX_TZ_OFFSET_MINUTES = 14 * 60;
const COMPLETENESS_NOTICE = "Recorded observations are not an all-time record. The official battle log is a recent rolling window; outages and time before tracking can be missing.";

type UnknownRecord = Record<string, unknown>;

interface BattleRow {
  id: string;
  battle_time: string;
  type: string;
  mode_id: number | null;
  mode_name: string;
  source: "api" | "manual";
  fetched_at: number;
  provenance_kind: TrackerBattleProvenance["kind"];
  provenance_label: string;
  unit: TrackerBattle["unit"];
  created_by: string | null;
  deck_selection: string | null;
  arena_id: number | null;
  arena_name: string | null;
  league_number: number | null;
  is_ladder_tournament: number | null;
  is_hosted_match: number | null;
  event_tag: string | null;
  tournament_tag: string | null;
}

interface ParticipantRow {
  battle_id: string;
  side: 0 | 1;
  position: number;
  profile_id: string | null;
  player_tag: string;
  player_name: string;
  crowns: number | null;
  result: TrackerBattleResult;
  elixir_leaked: number | null;
  cards_json: string;
  starting_trophies: number | null;
  trophy_change: number | null;
  king_tower_hp: number | null;
  princess_towers_hp_json: string | null;
  clan_tag: string | null;
  clan_name: string | null;
  global_rank: number | null;
  support_cards_json: string | null;
}

interface CommandRow { action: string; payload_hash: string; result_id: string }

interface PollRow {
  player_tag: string;
  display_name: string;
  first_tracked_at: number;
  last_attempt_at: number | null;
  last_success_at: number | null;
  next_poll_at: number | null;
  last_error: string | null;
  battles_seen: number;
  consecutive_failures: number;
  idle_streak: number;
  possible_gap_count: number;
  last_window_oldest: string | null;
  last_window_newest: string | null;
  last_window_keys_json: string;
}

/** `raw` is the API battle as received (icon URLs removed), kept so later features never depend on today's parser. */
interface NormalizedBattle extends TrackerBattle { dedupeKey: string; raw?: string | null }

export interface TrackerRegisteredPlayer {
  profileId: string;
  displayName: string;
  tag: string;
}

export interface TrackerSummaryRequest {
  actorProfileId: string;
  visibleProfileIds: ReadonlySet<string>;
  filters?: Partial<TrackerFilters>;
}

export interface TrackerInsightsRequest {
  actorProfileId: string;
  visibleProfileIds: ReadonlySet<string>;
  filters?: Partial<TrackerInsightsFilters>;
}

export interface TrackerPlayerRequest {
  actorProfileId: string;
  visibleProfileIds: ReadonlySet<string>;
  playerTag?: unknown;
}

export interface ParsedHistoricalImport {
  inputRows: number;
  rejectedRows: number;
  battles: Array<{ battle: NormalizedBattle; observedTags: string[] }>;
  earliestBattleAt: string | null;
  latestBattleAt: string | null;
  sourceLabel: string;
}

export interface TrackerServiceOptions {
  databasePath: string;
  getPlayers: () => TrackerRegisteredPlayer[];
  apiToken?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  quickPollMs?: number;
  maxIdlePollMs?: number;
  requestTimeoutMs?: number;
  jitterRatio?: number;
  random?: () => number;
  autoStart?: boolean;
}

export interface TrackerService {
  getRegisteredPlayers(): TrackerRegisteredPlayer[];
  getStatus(): TrackerPollStatus;
  getSummary(request: TrackerSummaryRequest): TrackerSummary;
  syncNow(tags?: readonly string[]): Promise<TrackerPollStatus>;
  requestSync(actorProfileId: string, visibleProfileIds: ReadonlySet<string>, rawTag?: unknown): Promise<TrackerPollStatus>;
  getBattleCountAudit(visibleProfileIds: ReadonlySet<string>, rawTag: unknown): TrackerBattleCountAudit;
  getDeckLog(request: { actorProfileId: string; visibleProfileIds: ReadonlySet<string>; playerTag?: unknown }): TrackerDeckLog;
  getInsights(request: TrackerInsightsRequest): TrackerInsights;
  getCardStats(request: TrackerPlayerRequest): TrackerCardStats;
  getDeckRecord(request: TrackerPlayerRequest & { cards: unknown }): TrackerDeckRecord;
  importHistorical(parsed: ParsedHistoricalImport, kind: "operator_snapshot" | "user_import", label?: string): TrackerImportResult;
  addManualResult(actorProfileId: string, visibleProfileIds: ReadonlySet<string>, input: unknown): ManualTrackerResultResponse;
  undoManualResult(actorProfileId: string, visibleProfileIds: ReadonlySet<string>, battleId: unknown, input: unknown): UndoManualTrackerResultResponse;
  close(): void;
}

export class TrackerError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) { super(message); }
}

class ApiPollError extends Error {
  constructor(message: string, readonly retryAfterMs: number | null = null) { super(message); }
}

const isRecord = (value: unknown): value is UnknownRecord => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, fallback = "") => typeof value === "string" && value.trim() ? value.trim() : fallback;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const integer = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) ? value : null;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const payloadHash = (value: unknown) => sha256(JSON.stringify(value));
export const normalizeTrackerTag = (value: unknown) => {
  const normalized = text(value).toUpperCase().replace(/\s+/g, "");
  if (!normalized) return "";
  return normalized.startsWith("#") ? normalized : `#${normalized}`;
};
const validTag = (tag: string) => /^#[0289PYLQGRJCUV]{3,15}$/i.test(tag);
const normalizePlayer = (player: TrackerRegisteredPlayer): TrackerRegisteredPlayer => ({
  profileId: player.profileId.trim(),
  displayName: player.displayName.trim(),
  tag: normalizeTrackerTag(player.tag),
});
const slugifyCardName = (name: string) => name.toLowerCase().replace(/[.']/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const safeJson = <T>(value: string, fallback: T): T => { try { return JSON.parse(value) as T; } catch { return fallback; } };

const normalizeBattleTime = (value: unknown, fallbackMs: number) => {
  const raw = text(value);
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?Z$/);
  if (compact) {
    const millis = (compact[7] ?? "0").padEnd(3, "0");
    return `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}.${millis}Z`;
  }
  if (raw && Number.isFinite(Date.parse(raw))) return new Date(raw).toISOString();
  return new Date(fallbackMs).toISOString();
};

const parseCardForm = (card: UnknownRecord): TrackerCardForm => {
  const formBits = integer(card.evolutionLevel) ?? 0;
  const evolution = (formBits & 1) === 1 || card.isEvolution === true;
  const hero = (formBits & 2) === 2 || (finite(card.heroLevel) ?? 0) > 0 || card.isHero === true;
  if (evolution && hero) return "heroEvolution";
  if (evolution) return "evolution";
  if (hero) return "hero";
  if (text(card.rarity).toLowerCase() === "champion") return "champion";
  return "base";
};

const parseCards = (value: unknown): TrackerCard[] => Array.isArray(value) ? value.slice(0, 12).flatMap((candidate) => {
  if (!isRecord(candidate)) return [];
  const name = text(candidate.name, "Unknown card");
  return [{ id: integer(candidate.id), key: slugifyCardName(name) || `card-${integer(candidate.id) ?? "unknown"}`, name, form: parseCardForm(candidate), elixirCost: finite(candidate.elixirCost), level: integer(candidate.level), maxLevel: integer(candidate.maxLevel) } satisfies TrackerCard];
}) : [];
const stripIconUrls = (value: unknown) => JSON.stringify(value, (key, entry: unknown) => key === "iconUrls" ? undefined : entry);
const flag = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;

const canonicalTeamSignatures = (teams: TrackerParticipant[][]) => teams.map((team) => team.map((participant) => participant.tag).sort().join(","));
const canonicalBattleKey = (battleTime: string, type: string, modeId: number | null, modeName: string, teams: TrackerParticipant[][]) => {
  const teamSignatures = canonicalTeamSignatures(teams).sort();
  return sha256(JSON.stringify([battleTime, type.toLowerCase(), modeId ?? modeName.toLowerCase(), teamSignatures]));
};

const resultForSide = (side: 0 | 1, teamCrowns: [number | null, number | null]): TrackerBattleResult => {
  const own = teamCrowns[side];
  const other = teamCrowns[side === 0 ? 1 : 0];
  if (own === null || other === null) return "unknown";
  if (own === other) return "draw";
  return own > other ? "win" : "loss";
};

const parseApiParticipants = (value: unknown, side: 0 | 1): TrackerParticipant[] =>
  (Array.isArray(value) ? value : []).slice(0, 4).flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const name = text(candidate.name, "Unknown player");
    const tag = normalizeTrackerTag(candidate.tag);
    if (!validTag(tag)) return [];
    const clan = isRecord(candidate.clan) && text(candidate.clan.tag) ? { tag: normalizeTrackerTag(candidate.clan.tag), name: text(candidate.clan.name, "Unknown clan") } : null;
    const towers = Array.isArray(candidate.princessTowersHitPoints) ? candidate.princessTowersHitPoints.flatMap((points) => integer(points) === null ? [] : [integer(points)!]).slice(0, 4) : null;
    return [{
      profileId: null, tag, name, side, crowns: integer(candidate.crowns), result: "unknown" as const, elixirLeaked: finite(candidate.elixirLeaked), cards: parseCards(candidate.cards),
      startingTrophies: integer(candidate.startingTrophies), trophyChange: integer(candidate.trophyChange), kingTowerHitPoints: integer(candidate.kingTowerHitPoints),
      princessTowersHitPoints: towers, clan, globalRank: integer(candidate.globalRank), supportCards: parseCards(candidate.supportCards),
    }];
  }).sort((left, right) => left.tag.localeCompare(right.tag));

export const normalizeApiBattle = (
  value: unknown,
  fetchedAt: number,
  provenance: TrackerBattleProvenance = { kind: "server_fetch", label: "Clash Royale API", observedAt: fetchedAt },
): NormalizedBattle | null => {
  if (!isRecord(value)) return null;
  const battleTimeRaw = text(value.battleTime);
  const compactTime = /^\d{8}T\d{6}(?:\.\d{1,3})?Z$/.test(battleTimeRaw);
  if (!battleTimeRaw || (!compactTime && !Number.isFinite(Date.parse(battleTimeRaw)))) return null;
  const battleTime = normalizeBattleTime(battleTimeRaw, fetchedAt);
  if (!Number.isFinite(Date.parse(battleTime))) return null;
  const type = text(value.type);
  if (!type) return null;
  const gameMode = isRecord(value.gameMode) ? value.gameMode : {};
  const mode = { id: integer(gameMode.id), name: text(gameMode.name, "Unknown mode") };
  let teams: [TrackerParticipant[], TrackerParticipant[]] = [parseApiParticipants(value.team, 0), parseApiParticipants(value.opponent, 1)];
  if (teams[0].length === 0 || teams[1].length === 0) return null;
  const initialSignatures = canonicalTeamSignatures(teams);
  if (initialSignatures[0]! > initialSignatures[1]!) teams = [teams[1].map((participant) => ({ ...participant, side: 0 })), teams[0].map((participant) => ({ ...participant, side: 1 }))];
  const teamCrowns = teams.map((team) => {
    const values = team.map((participant) => participant.crowns);
    return values.some((crowns) => crowns === null) ? null : Math.max(...values as number[]);
  }) as [number | null, number | null];
  teams = teams.map((team, side) => team.map((participant) => ({ ...participant, side: side as 0 | 1, result: resultForSide(side as 0 | 1, teamCrowns) }))) as typeof teams;
  const dedupeKey = canonicalBattleKey(battleTime, type, mode.id, mode.name, teams);
  const unit = /duel/i.test(`${type} ${mode.name}`) ? "duel_round" : "match";
  const arena = isRecord(value.arena) ? { id: integer(value.arena.id), name: text(value.arena.name, "Unknown arena") } : null;
  return {
    id: `api_${dedupeKey.slice(0, 24)}`, dedupeKey, battleTime, type, mode, source: "api", unit, fetchedAt, provenance, participants: teams.flat(),
    deckSelection: text(value.deckSelection) || null, arena, leagueNumber: integer(value.leagueNumber), isLadderTournament: flag(value.isLadderTournament),
    isHostedMatch: flag(value.isHostedMatch), eventTag: text(value.eventTag) || null, tournamentTag: text(value.tournamentTag) || null, raw: stripIconUrls(value),
  };
};

export const parseHistoricalImport = (value: unknown, importedAt: number, kind: "operator_snapshot" | "user_import", label = "Imported API observations"): ParsedHistoricalImport => {
  const provenance: TrackerBattleProvenance = { kind, label: label.slice(0, 160), observedAt: importedAt };
  let inputRows = 0;
  let rejectedRows = 0;
  let sourceLabel = provenance.label;
  const candidates: Array<{ value: unknown; observedTag: string | null; fetchedAt: number }> = [];
  if (Array.isArray(value)) {
    inputRows = value.length;
    for (const battle of value) candidates.push({ value: battle, observedTag: null, fetchedAt: importedAt });
  } else if (isRecord(value) && Array.isArray(value.players)) {
    const sourceMetadata = text(value.source);
    sourceLabel = (sourceMetadata ? `${sourceLabel} · ${sourceMetadata}` : sourceLabel).slice(0, 160);
    for (const playerValue of value.players) {
      if (!isRecord(playerValue) || !Array.isArray(playerValue.battles)) { rejectedRows += 1; continue; }
      const observedTag = normalizeTrackerTag(playerValue.tag);
      if (!validTag(observedTag)) { rejectedRows += playerValue.battles.length; inputRows += playerValue.battles.length; continue; }
      const fetchedAt = Number.isFinite(Date.parse(text(playerValue.fetchedAt))) ? Date.parse(text(playerValue.fetchedAt)) : importedAt;
      inputRows += playerValue.battles.length;
      for (const battle of playerValue.battles) candidates.push({ value: battle, observedTag, fetchedAt });
    }
  } else {
    throw new TrackerError(400, "Unsupported history file. Expected a Clash API battle array or a snapshot with players[].battles[].", "UNSUPPORTED_IMPORT_SCHEMA");
  }
  const byKey = new Map<string, { battle: NormalizedBattle; observedTags: Set<string> }>();
  for (const candidate of candidates) {
    const battle = normalizeApiBattle(candidate.value, candidate.fetchedAt, { ...provenance, label: sourceLabel, observedAt: candidate.fetchedAt });
    if (!battle || (candidate.observedTag && !battle.participants.some((participant) => participant.tag === candidate.observedTag))) { rejectedRows += 1; continue; }
    const existing = byKey.get(battle.dedupeKey) ?? { battle, observedTags: new Set<string>() };
    if (candidate.observedTag) existing.observedTags.add(candidate.observedTag);
    byKey.set(battle.dedupeKey, existing);
  }
  const battles = [...byKey.values()].map((entry) => ({ battle: entry.battle, observedTags: [...entry.observedTags] }));
  const times = battles.map((entry) => entry.battle.battleTime).sort();
  return { inputRows, rejectedRows, battles, earliestBattleAt: times[0] ?? null, latestBattleAt: times.at(-1) ?? null, sourceLabel };
};

const pairKey = (left: string, right: string) => left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;

const requireCommandId = (value: unknown) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100) throw new TrackerError(400, "commandId is required", "INVALID_INPUT");
  return value.trim();
};
const requireProfileIds = (value: unknown, label: string) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 || value.some((item) => typeof item !== "string" || !item.trim())) throw new TrackerError(400, `${label} must contain one or two player profiles`, "INVALID_INPUT");
  return value.map((item) => String(item).trim());
};
const requireCrowns = (value: unknown, label: string) => {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 3) throw new TrackerError(400, `${label} must be an integer from 0 to 3`, "INVALID_INPUT");
  return Number(value);
};

export const createTrackerService = (options: TrackerServiceOptions): TrackerService => {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiToken = options.apiToken?.trim() ?? "";
  const apiBaseUrl = (options.apiBaseUrl?.trim() || DEFAULT_API_BASE_URL).replace(/\/$/, "");
  const quickPollMs = Math.max(10_000, options.quickPollMs ?? DEFAULT_QUICK_POLL_MS);
  const maxIdlePollMs = Math.max(quickPollMs, options.maxIdlePollMs ?? DEFAULT_MAX_IDLE_POLL_MS);
  const requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const jitterRatio = Math.min(0.25, Math.max(0, options.jitterRatio ?? 0.1));
  const random = options.random ?? Math.random;
  const autoStart = options.autoStart ?? true;
  if (options.databasePath !== ":memory:") fs.mkdirSync(path.dirname(options.databasePath), { recursive: true });
  const db = new DatabaseSync(options.databasePath);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracker_battles (
      id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, battle_time TEXT NOT NULL, type TEXT NOT NULL,
      mode_id INTEGER, mode_name TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('api','manual')),
      fetched_at INTEGER NOT NULL, created_by TEXT, undone_at INTEGER,
      provenance_kind TEXT NOT NULL DEFAULT 'server_fetch', provenance_label TEXT NOT NULL DEFAULT 'Clash Royale API', unit TEXT NOT NULL DEFAULT 'match'
    );
    CREATE TABLE IF NOT EXISTS tracker_participants (
      battle_id TEXT NOT NULL, side INTEGER NOT NULL CHECK (side IN (0,1)), position INTEGER NOT NULL,
      profile_id TEXT, player_tag TEXT NOT NULL, player_name TEXT NOT NULL, crowns INTEGER,
      result TEXT NOT NULL CHECK (result IN ('win','loss','draw','unknown')), elixir_leaked REAL, cards_json TEXT NOT NULL,
      PRIMARY KEY (battle_id, side, position), FOREIGN KEY (battle_id) REFERENCES tracker_battles(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS tracker_commands (
      actor_profile_id TEXT NOT NULL, command_id TEXT NOT NULL, action TEXT NOT NULL, payload_hash TEXT NOT NULL,
      result_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (actor_profile_id, command_id)
    );
    CREATE TABLE IF NOT EXISTS tracker_poll_state (
      profile_id TEXT PRIMARY KEY, last_attempt_at INTEGER, last_success_at INTEGER, last_error TEXT, battles_seen INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tracker_profile_tag_links (
      profile_id TEXT NOT NULL, player_tag TEXT NOT NULL, display_name TEXT NOT NULL, started_at INTEGER NOT NULL,
      ended_at INTEGER, PRIMARY KEY (profile_id, player_tag, started_at)
    );
    CREATE TABLE IF NOT EXISTS tracker_tag_poll_state (
      player_tag TEXT PRIMARY KEY, display_name TEXT NOT NULL, first_tracked_at INTEGER NOT NULL,
      last_attempt_at INTEGER, last_success_at INTEGER, next_poll_at INTEGER, last_error TEXT,
      battles_seen INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0,
      idle_streak INTEGER NOT NULL DEFAULT 0, possible_gap_count INTEGER NOT NULL DEFAULT 0,
      last_window_oldest TEXT, last_window_newest TEXT, last_window_keys_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS tracker_battle_observations (
      battle_id TEXT NOT NULL, observer_tag TEXT NOT NULL, provenance_kind TEXT NOT NULL,
      provenance_label TEXT NOT NULL, first_observed_at INTEGER NOT NULL, last_observed_at INTEGER NOT NULL,
      observation_count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (battle_id, observer_tag, provenance_kind),
      FOREIGN KEY (battle_id) REFERENCES tracker_battles(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS tracker_poll_attempts (
      id TEXT PRIMARY KEY, player_tag TEXT NOT NULL, attempted_at INTEGER NOT NULL, completed_at INTEGER NOT NULL,
      success INTEGER NOT NULL, response_count INTEGER NOT NULL, inserted_count INTEGER NOT NULL,
      window_oldest TEXT, window_newest TEXT, error TEXT, retry_after_ms INTEGER, possible_gap INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tracker_raw_responses (
      id TEXT PRIMARY KEY, player_tag TEXT NOT NULL, fetched_at INTEGER NOT NULL, payload_sha256 TEXT NOT NULL,
      raw_bytes INTEGER NOT NULL, payload_json TEXT
    );
    CREATE TABLE IF NOT EXISTS tracker_coverage_gaps (
      player_tag TEXT NOT NULL, gap_start TEXT NOT NULL, gap_end TEXT NOT NULL, detected_at INTEGER NOT NULL,
      reason TEXT NOT NULL, PRIMARY KEY (player_tag, gap_start, gap_end)
    );
    CREATE TABLE IF NOT EXISTS tracker_profile_snapshots (
      player_tag TEXT NOT NULL, fetched_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, battle_count INTEGER, wins INTEGER, losses INTEGER,
      three_crown_wins INTEGER, trophies INTEGER, best_trophies INTEGER, exp_level INTEGER, path_of_legend_json TEXT, current_deck_json TEXT,
      PRIMARY KEY (player_tag, fetched_at)
    );
    CREATE TABLE IF NOT EXISTS tracker_battle_raw (
      battle_id TEXT PRIMARY KEY, observer_tag TEXT NOT NULL, stored_at INTEGER NOT NULL, raw_json TEXT NOT NULL,
      FOREIGN KEY (battle_id) REFERENCES tracker_battles(id) ON DELETE CASCADE
    );
  `);
  const ensureColumn = (table: string, name: string, sql: string) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${sql}`);
  };
  ensureColumn("tracker_battles", "provenance_kind", "TEXT NOT NULL DEFAULT 'server_fetch'");
  ensureColumn("tracker_battles", "provenance_label", "TEXT NOT NULL DEFAULT 'Clash Royale API'");
  ensureColumn("tracker_battles", "unit", "TEXT NOT NULL DEFAULT 'match'");
  // detail_version 0 rows predate full battle detail; a later sighting of the same battle upgrades them in place.
  ensureColumn("tracker_battles", "detail_version", "INTEGER NOT NULL DEFAULT 0");
  for (const [name, sql] of [["deck_selection", "TEXT"], ["arena_id", "INTEGER"], ["arena_name", "TEXT"], ["league_number", "INTEGER"], ["is_ladder_tournament", "INTEGER"], ["is_hosted_match", "INTEGER"], ["event_tag", "TEXT"], ["tournament_tag", "TEXT"]] as const) ensureColumn("tracker_battles", name, sql);
  for (const [name, sql] of [["starting_trophies", "INTEGER"], ["trophy_change", "INTEGER"], ["king_tower_hp", "INTEGER"], ["princess_towers_hp_json", "TEXT"], ["clan_tag", "TEXT"], ["clan_name", "TEXT"], ["global_rank", "INTEGER"], ["support_cards_json", "TEXT"]] as const) ensureColumn("tracker_participants", name, sql);
  db.exec(`
    CREATE INDEX IF NOT EXISTS tracker_battles_time ON tracker_battles(battle_time DESC);
    CREATE INDEX IF NOT EXISTS tracker_participants_profile ON tracker_participants(profile_id, battle_id);
    CREATE INDEX IF NOT EXISTS tracker_participants_tag ON tracker_participants(player_tag, battle_id);
    CREATE INDEX IF NOT EXISTS tracker_links_profile ON tracker_profile_tag_links(profile_id, ended_at);
    CREATE INDEX IF NOT EXISTS tracker_attempts_tag_time ON tracker_poll_attempts(player_tag, attempted_at DESC);
  `);

  let closed = false;
  let lastPollAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pollingTags = new Set<string>();
  const activeControllers = new Set<AbortController>();
  const manualSyncAt = new Map<string, number>();

  const ensureOpen = () => { if (closed) throw new TrackerError(503, "Game tracker is closed", "SERVICE_CLOSED"); };
  const getRegisteredPlayers = () => options.getPlayers().map(normalizePlayer).filter((player) => player.profileId && player.displayName && validTag(player.tag));
  const transaction = <T>(operation: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };

  // SQLite cannot reference the metadata table before it exists, so create it separately.
  db.exec("CREATE TABLE IF NOT EXISTS tracker_schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  transaction(() => {
    const prior = db.prepare("SELECT value FROM tracker_schema_meta WHERE key = 'tag_centric_v2'").get() as { value: string } | undefined;
    if (prior) return;
    const rows = db.prepare(`SELECT DISTINCT p.profile_id,p.player_tag,p.player_name
      FROM tracker_participants p WHERE p.profile_id IS NOT NULL`).all() as Array<{ profile_id: string; player_tag: string; player_name: string }>;
    const insert = db.prepare("INSERT OR IGNORE INTO tracker_profile_tag_links(profile_id,player_tag,display_name,started_at,ended_at) VALUES(?,?,?,?,NULL)");
    for (const row of rows) insert.run(row.profile_id, normalizeTrackerTag(row.player_tag), row.player_name, 0);
    db.prepare("UPDATE tracker_battles SET dedupe_key = 'manual:' || dedupe_key WHERE source = 'manual' AND dedupe_key NOT LIKE 'manual:%'").run();
    db.prepare("UPDATE tracker_participants SET profile_id = NULL WHERE battle_id IN (SELECT id FROM tracker_battles WHERE source = 'api')").run();
    db.prepare("INSERT INTO tracker_schema_meta(key,value) VALUES('tag_centric_v2','1')").run();
  });
  const reconcileSubscriptions = () => transaction(() => {
    const timestamp = now();
    const current = getRegisteredPlayers();
    const byProfile = new Map(current.map((player) => [player.profileId, player]));
    const active = db.prepare("SELECT profile_id,player_tag,display_name,started_at FROM tracker_profile_tag_links WHERE ended_at IS NULL").all() as Array<{ profile_id: string; player_tag: string; display_name: string; started_at: number }>;
    const activeByProfile = new Map<string, typeof active>();
    for (const link of active) activeByProfile.set(link.profile_id, [...(activeByProfile.get(link.profile_id) ?? []), link]);
    for (const [profileId, links] of activeByProfile) {
      const player = byProfile.get(profileId);
      for (const link of links) {
        if (!player || link.player_tag !== player.tag) db.prepare("UPDATE tracker_profile_tag_links SET ended_at = ? WHERE profile_id = ? AND player_tag = ? AND started_at = ?").run(timestamp, profileId, link.player_tag, link.started_at);
        else db.prepare("UPDATE tracker_profile_tag_links SET display_name = ? WHERE profile_id = ? AND player_tag = ? AND started_at = ?").run(player.displayName, profileId, link.player_tag, link.started_at);
      }
    }
    for (const player of current) {
      const matching = (activeByProfile.get(player.profileId) ?? []).some((link) => link.player_tag === player.tag);
      if (!matching) db.prepare("INSERT INTO tracker_profile_tag_links(profile_id,player_tag,display_name,started_at,ended_at) VALUES(?,?,?,?,NULL)").run(player.profileId, player.tag, player.displayName, timestamp);
      db.prepare(`INSERT INTO tracker_tag_poll_state(player_tag,display_name,first_tracked_at,next_poll_at)
        VALUES(?,?,?,?) ON CONFLICT(player_tag) DO UPDATE SET display_name=excluded.display_name`)
        .run(player.tag, player.displayName, timestamp, timestamp + Math.round(random() * quickPollMs));
    }
  });

  const activeTags = () => {
    reconcileSubscriptions();
    const rows = db.prepare(`SELECT player_tag,max(display_name) AS display_name,count(DISTINCT profile_id) AS subscriber_count
      FROM tracker_profile_tag_links WHERE ended_at IS NULL GROUP BY player_tag ORDER BY player_tag`).all() as Array<{ player_tag: string; display_name: string; subscriber_count: number }>;
    return rows.map((row) => ({ tag: row.player_tag, displayName: row.display_name, subscriberCount: Number(row.subscriber_count) }));
  };

  const visibleTags = (visibleProfileIds: ReadonlySet<string>) => {
    if (visibleProfileIds.size === 0) return new Set<string>();
    const rows = db.prepare("SELECT DISTINCT profile_id,player_tag FROM tracker_profile_tag_links").all() as Array<{ profile_id: string; player_tag: string }>;
    return new Set(rows.filter((row) => visibleProfileIds.has(row.profile_id)).map((row) => row.player_tag));
  };

  const visiblePlayers = (visibleProfileIds: ReadonlySet<string>): TrackerPlayer[] => {
    const rows = db.prepare("SELECT profile_id,player_tag,display_name,started_at,ended_at FROM tracker_profile_tag_links").all() as Array<{ profile_id: string; player_tag: string; display_name: string; started_at: number; ended_at: number | null }>;
    const grouped = new Map<string, { names: Array<{ value: string; at: number }>; profiles: Set<string>; activeProfiles: Set<string> }>();
    for (const row of rows) if (visibleProfileIds.has(row.profile_id)) {
      const current = grouped.get(row.player_tag) ?? { names: [], profiles: new Set<string>(), activeProfiles: new Set<string>() };
      current.names.push({ value: row.display_name, at: row.started_at });
      current.profiles.add(row.profile_id);
      if (row.ended_at === null) current.activeProfiles.add(row.profile_id);
      grouped.set(row.player_tag, current);
    }
    return [...grouped.entries()].map(([tag, value]) => ({
      tag,
      displayName: value.names.sort((left, right) => right.at - left.at)[0]?.value ?? tag,
      linkedProfileIds: [...value.profiles].sort(),
      activeProfileIds: [...value.activeProfiles].sort(),
    })).sort((left, right) => left.displayName.localeCompare(right.displayName));
  };

  const recordObservation = (battleId: string, observerTag: string, provenance: TrackerBattleProvenance) => {
    const tag = normalizeTrackerTag(observerTag) || "#UNKNOWN";
    db.prepare(`INSERT INTO tracker_battle_observations(battle_id,observer_tag,provenance_kind,provenance_label,first_observed_at,last_observed_at,observation_count)
      VALUES(?,?,?,?,?,?,1) ON CONFLICT(battle_id,observer_tag,provenance_kind) DO UPDATE SET
      provenance_label=excluded.provenance_label,last_observed_at=excluded.last_observed_at,observation_count=tracker_battle_observations.observation_count+1`)
      .run(battleId, tag, provenance.kind, provenance.label, provenance.observedAt, provenance.observedAt);
  };

  const DETAIL_VERSION = 1;
  const bit = (value: boolean | null | undefined) => value === null || value === undefined ? null : value ? 1 : 0;
  const battleDetailValues = (battle: NormalizedBattle) => [battle.deckSelection ?? null, battle.arena?.id ?? null, battle.arena?.name ?? null, battle.leagueNumber ?? null, bit(battle.isLadderTournament), bit(battle.isHostedMatch), battle.eventTag ?? null, battle.tournamentTag ?? null];
  const participantDetailValues = (participant: TrackerParticipant) => [participant.startingTrophies ?? null, participant.trophyChange ?? null, participant.kingTowerHitPoints ?? null, participant.princessTowersHitPoints ? JSON.stringify(participant.princessTowersHitPoints) : null, participant.clan?.tag ?? null, participant.clan?.name ?? null, participant.globalRank ?? null, participant.supportCards ? JSON.stringify(participant.supportCards) : null];
  const storeBattleRaw = (battleId: string, battle: NormalizedBattle, observerTag: string) => {
    if (battle.raw) db.prepare("INSERT OR IGNORE INTO tracker_battle_raw(battle_id,observer_tag,stored_at,raw_json) VALUES(?,?,?,?)").run(battleId, observerTag, now(), battle.raw);
  };

  const insertBattle = (battle: NormalizedBattle, createdBy: string | null, observedTags: readonly string[] = []) => {
    const detailVersion = battle.raw ? DETAIL_VERSION : 0;
    const inserted = db.prepare(`INSERT OR IGNORE INTO tracker_battles
      (id,dedupe_key,battle_time,type,mode_id,mode_name,source,fetched_at,created_by,undone_at,provenance_kind,provenance_label,unit,detail_version,
       deck_selection,arena_id,arena_name,league_number,is_ladder_tournament,is_hosted_match,event_tag,tournament_tag)
      VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(battle.id, battle.dedupeKey, battle.battleTime, battle.type, battle.mode.id, battle.mode.name, battle.source, battle.fetchedAt, createdBy, battle.provenance.kind, battle.provenance.label, battle.unit, detailVersion, ...battleDetailValues(battle));
    let id = battle.id;
    const observerTag = observedTags[0] ?? battle.participants[0]?.tag ?? "#UNKNOWN";
    if (Number(inserted.changes) === 0) {
      const existing = db.prepare("SELECT id,provenance_kind,detail_version FROM tracker_battles WHERE dedupe_key = ?").get(battle.dedupeKey) as { id: string; provenance_kind: string; detail_version: number } | undefined;
      id = existing?.id ?? battle.id;
      if (battle.provenance.kind === "server_fetch" && existing?.provenance_kind !== "server_fetch") db.prepare("UPDATE tracker_battles SET provenance_kind=?,provenance_label=?,fetched_at=? WHERE id=?").run(battle.provenance.kind, battle.provenance.label, battle.fetchedAt, id);
      if (existing && battle.raw && existing.detail_version < DETAIL_VERSION) {
        db.prepare(`UPDATE tracker_battles SET detail_version=?,deck_selection=?,arena_id=?,arena_name=?,league_number=?,is_ladder_tournament=?,is_hosted_match=?,event_tag=?,tournament_tag=? WHERE id=?`)
          .run(DETAIL_VERSION, ...battleDetailValues(battle), id);
        const update = db.prepare(`UPDATE tracker_participants SET cards_json=?,starting_trophies=?,trophy_change=?,king_tower_hp=?,princess_towers_hp_json=?,clan_tag=?,clan_name=?,global_rank=?,support_cards_json=?
          WHERE battle_id=? AND player_tag=?`);
        for (const participant of battle.participants) update.run(JSON.stringify(participant.cards), ...participantDetailValues(participant), id, participant.tag);
        storeBattleRaw(id, battle, observerTag);
      }
    } else {
      const statement = db.prepare(`INSERT INTO tracker_participants
        (battle_id,side,position,profile_id,player_tag,player_name,crowns,result,elixir_leaked,cards_json,
         starting_trophies,trophy_change,king_tower_hp,princess_towers_hp_json,clan_tag,clan_name,global_rank,support_cards_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const side of [0, 1] as const) {
        const participants = battle.participants.filter((participant) => participant.side === side).sort((left, right) => left.tag.localeCompare(right.tag));
        participants.forEach((participant, position) => statement.run(id, side, position, participant.profileId, participant.tag, participant.name, participant.crowns, participant.result, participant.elixirLeaked, JSON.stringify(participant.cards), ...participantDetailValues(participant)));
      }
      storeBattleRaw(id, battle, observerTag);
    }
    for (const observedTag of observedTags.length ? observedTags : battle.participants.map((participant) => participant.tag)) recordObservation(id, observedTag, battle.provenance);
    return { inserted: Number(inserted.changes) > 0, id };
  };

  const BATTLE_COLUMNS = "id,battle_time,type,mode_id,mode_name,source,fetched_at,provenance_kind,provenance_label,unit,created_by,deck_selection,arena_id,arena_name,league_number,is_ladder_tournament,is_hosted_match,event_tag,tournament_tag";
  const PARTICIPANT_COLUMNS = "battle_id,side,position,profile_id,player_tag,player_name,crowns,result,elixir_leaked,cards_json,starting_trophies,trophy_change,king_tower_hp,princess_towers_hp_json,clan_tag,clan_name,global_rank,support_cards_json";
  const unbit = (value: number | null) => value === null ? null : value === 1;
  const projectBattle = (row: BattleRow, participantRows: ParticipantRow[]): TrackerBattle => ({
    id: row.id, battleTime: row.battle_time, type: row.type, mode: { id: row.mode_id, name: row.mode_name }, source: row.source,
    unit: row.unit, fetchedAt: row.fetched_at, provenance: { kind: row.provenance_kind, label: row.provenance_label, observedAt: row.fetched_at },
    deckSelection: row.deck_selection, arena: row.arena_name === null ? null : { id: row.arena_id, name: row.arena_name }, leagueNumber: row.league_number,
    isLadderTournament: unbit(row.is_ladder_tournament), isHostedMatch: unbit(row.is_hosted_match), eventTag: row.event_tag, tournamentTag: row.tournament_tag,
    participants: participantRows.map((participant) => ({
      profileId: participant.profile_id, tag: participant.player_tag, name: participant.player_name, side: participant.side, crowns: participant.crowns, result: participant.result, elixirLeaked: participant.elixir_leaked, cards: safeJson(participant.cards_json, []),
      startingTrophies: participant.starting_trophies, trophyChange: participant.trophy_change, kingTowerHitPoints: participant.king_tower_hp, princessTowersHitPoints: participant.princess_towers_hp_json ? safeJson<number[] | null>(participant.princess_towers_hp_json, null) : null,
      clan: participant.clan_tag ? { tag: participant.clan_tag, name: participant.clan_name ?? "Unknown clan" } : null, globalRank: participant.global_rank, supportCards: participant.support_cards_json ? safeJson<TrackerCard[]>(participant.support_cards_json, []) : [],
    })),
  });

  const readBattle = (battleId: string): TrackerBattle => {
    const row = db.prepare(`SELECT ${BATTLE_COLUMNS} FROM tracker_battles WHERE id = ?`).get(battleId) as unknown as BattleRow | undefined;
    if (!row) throw new TrackerError(404, "Tracked game was not found", "NOT_FOUND");
    const participantRows = db.prepare(`SELECT ${PARTICIPANT_COLUMNS} FROM tracker_participants WHERE battle_id = ? ORDER BY side,position`).all(row.id) as unknown as ParticipantRow[];
    return projectBattle(row, participantRows);
  };

  // Insights only ever read one player's battles, so `participantTag` keeps them from loading every visible player's history.
  const visibleBattles = (actorProfileId: string, visibleProfileIds: ReadonlySet<string>, participantTag?: string) => {
    const tags = visibleTags(visibleProfileIds);
    const played = participantTag ? " AND id IN (SELECT battle_id FROM tracker_participants WHERE player_tag = ?)" : "";
    const scope = participantTag ? [participantTag] : [];
    const rows = db.prepare(`SELECT ${BATTLE_COLUMNS} FROM tracker_battles WHERE undone_at IS NULL${played} ORDER BY battle_time DESC`).all(...scope) as unknown as BattleRow[];
    if (rows.length === 0 || visibleProfileIds.size === 0) return [];
    const participants = db.prepare(`SELECT ${PARTICIPANT_COLUMNS} FROM tracker_participants
      WHERE battle_id IN (SELECT id FROM tracker_battles WHERE undone_at IS NULL${played}) ORDER BY battle_id,side,position`).all(...scope) as unknown as ParticipantRow[];
    const byBattle = new Map<string, ParticipantRow[]>();
    for (const participant of participants) { const list = byBattle.get(participant.battle_id); if (list) list.push(participant); else byBattle.set(participant.battle_id, [participant]); }
    return rows.flatMap((row) => {
      const participantRows = byBattle.get(row.id) ?? [];
      const allowed = row.source === "api"
        ? participantRows.some((participant) => tags.has(participant.player_tag))
        : Boolean(row.created_by && (row.created_by === actorProfileId || visibleProfileIds.has(row.created_by)));
      return allowed ? [projectBattle(row, participantRows)] : [];
    });
  };

  const projectPollPlayers = (): TrackerPollPlayerStatus[] => {
    const tags = activeTags();
    const states = db.prepare("SELECT * FROM tracker_tag_poll_state").all() as unknown as PollRow[];
    const byTag = new Map(states.map((row) => [row.player_tag, row]));
    return tags.map((player) => {
      const row = byTag.get(player.tag)!;
      return { displayName: player.displayName, tag: player.tag, subscriberCount: player.subscriberCount, trackingStartedAt: row.first_tracked_at, lastAttemptAt: row.last_attempt_at, lastSuccessAt: row.last_success_at, nextPollAt: row.next_poll_at, lastError: row.last_error, battlesSeen: row.battles_seen, consecutiveFailures: row.consecutive_failures, idleStreak: row.idle_streak, possibleGapCount: row.possible_gap_count };
    });
  };

  const getStatus = (): TrackerPollStatus => {
    if (closed) return { configured: Boolean(apiToken), state: "closed", lastPollAt, lastSuccessfulPollAt: null, nextPollAt: null, stale: true, message: "Game tracker is closed.", requestBudget: { trackedTags: 0, quickPollRequestsPerDay: 0, maximumIdleRequestsPerDay: 0 }, players: [] };
    const players = projectPollPlayers();
    const successful = players.map((player) => player.lastSuccessAt).filter((value): value is number => value !== null);
    const lastSuccessfulPollAt = successful.length ? Math.max(...successful) : null;
    const nextValues = players.map((player) => player.nextPollAt).filter((value): value is number => value !== null);
    const nextPollAt = nextValues.length ? Math.min(...nextValues) : null;
    const stale = lastSuccessfulPollAt === null || now() - lastSuccessfulPollAt > Math.max(5 * 60_000, maxIdlePollMs * 2);
    const anyFailures = players.some((player) => player.consecutiveFailures > 0);
    const state = !apiToken ? "missing_token" : pollingTags.size ? "polling" : anyFailures ? "backoff" : "ready";
    const message = !apiToken
      ? "Automatic history needs the server's Clash Royale API key. Saved and manual observations remain available."
      : stale ? "Collection is running, but one or more tags have not synced recently. Gaps are possible while the server or API is unavailable."
        : "Each distinct player tag is collected once. Recent API windows can overlap, and outages may leave gaps.";
    return {
      configured: Boolean(apiToken), state, lastPollAt, lastSuccessfulPollAt, nextPollAt, stale, message,
      requestBudget: { trackedTags: players.length, quickPollRequestsPerDay: players.length * Math.ceil(86_400_000 / quickPollMs), maximumIdleRequestsPerDay: players.length * Math.ceil(86_400_000 / maxIdlePollMs) },
      players,
    };
  };

  const normalizeFilters = (players: TrackerPlayer[], actorProfileId: string, raw: Partial<TrackerFilters> = {}): TrackerFilters => {
    const allowed = new Set(players.map((player) => player.tag));
    const own = players.find((player) => player.linkedProfileIds.includes(actorProfileId))?.tag ?? players[0]?.tag ?? "";
    const requested = normalizeTrackerTag(raw.playerTag);
    const playerTag = allowed.has(requested) ? requested : own;
    const relationship: TrackerRelationship = raw.relationship === "versus" || raw.relationship === "alongside" ? raw.relationship : "all";
    const opponent = normalizeTrackerTag(raw.opponentTag);
    const opponentTag = relationship !== "all" && opponent && opponent !== playerTag ? opponent : null;
    const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
    return { playerTag, opponentTag, relationship, mode: text(raw.mode) || null, dateFrom: date(raw.dateFrom), dateTo: date(raw.dateTo) };
  };

  const getCoverage = (playerTag: string, battles: TrackerBattle[]): TrackerCoverage | null => {
    if (!playerTag) return null;
    const relevant = battles.filter((battle) => battle.participants.some((participant) => participant.tag === playerTag));
    const state = db.prepare("SELECT first_tracked_at,last_success_at FROM tracker_tag_poll_state WHERE player_tag=?").get(playerTag) as { first_tracked_at: number; last_success_at: number | null } | undefined;
    const links = db.prepare("SELECT min(started_at) AS first FROM tracker_profile_tag_links WHERE player_tag=?").get(playerTag) as { first: number | null };
    const gaps = db.prepare("SELECT gap_start,gap_end,detected_at,reason FROM tracker_coverage_gaps WHERE player_tag=? ORDER BY gap_start DESC LIMIT 20").all(playerTag) as Array<{ gap_start: string; gap_end: string; detected_at: number; reason: "non_overlapping_api_windows" }>;
    const times = relevant.map((battle) => battle.battleTime).sort();
    const sourceCounts = { api: 0, manual: 0 };
    const provenanceCounts = { serverFetch: 0, operatorSnapshot: 0, userImport: 0, manual: 0 };
    for (const battle of relevant) {
      sourceCounts[battle.source] += 1;
      if (battle.provenance.kind === "server_fetch") provenanceCounts.serverFetch += 1;
      else if (battle.provenance.kind === "operator_snapshot") provenanceCounts.operatorSnapshot += 1;
      else if (battle.provenance.kind === "user_import") provenanceCounts.userImport += 1;
      else provenanceCounts.manual += 1;
    }
    return { playerTag, trackingStartedAt: state?.first_tracked_at ?? links.first ?? null, earliestBattleAt: times[0] ?? null, latestBattleAt: times.at(-1) ?? null, lastSuccessfulSyncAt: state?.last_success_at ?? null, possibleGaps: gaps.map((gap) => ({ startAt: gap.gap_start, endAt: gap.gap_end, detectedAt: gap.detected_at, reason: gap.reason })), sourceCounts, provenanceCounts };
  };

  const getSummary = (request: TrackerSummaryRequest): TrackerSummary => {
    ensureOpen();
    reconcileSubscriptions();
    const players = visiblePlayers(request.visibleProfileIds);
    const playerByTag = new Map(players.map((player) => [player.tag, player]));
    const allBattles = visibleBattles(request.actorProfileId, request.visibleProfileIds);
    const filters = normalizeFilters(players, request.actorProfileId, request.filters);
    const modeOptions = new Map<string, string>();
    for (const battle of allBattles) if (battle.participants.some((participant) => participant.tag === filters.playerTag)) modeOptions.set(`${battle.mode.id ?? "name"}:${battle.mode.name}`, battle.mode.name);
    const startMs = filters.dateFrom ? Date.parse(`${filters.dateFrom}T00:00:00.000Z`) : Number.NEGATIVE_INFINITY;
    const endMs = filters.dateTo ? Date.parse(`${filters.dateTo}T23:59:59.999Z`) : Number.POSITIVE_INFINITY;
    const battles = allBattles.filter((battle) => {
      const focus = battle.participants.find((participant) => participant.tag === filters.playerTag);
      if (!focus) return false;
      const battleMs = Date.parse(battle.battleTime);
      if (battleMs < startMs || battleMs > endMs) return false;
      const modeKey = `${battle.mode.id ?? "name"}:${battle.mode.name}`;
      if (filters.mode && filters.mode !== modeKey) return false;
      if (!filters.opponentTag) return filters.relationship === "all";
      const selected = battle.participants.find((participant) => participant.tag === filters.opponentTag);
      if (!selected) return false;
      if (filters.relationship === "versus") return selected.side !== focus.side;
      if (filters.relationship === "alongside") return selected.side === focus.side && battle.participants.filter((participant) => participant.side === focus.side).length > 1;
      return true;
    });
    const playerTallies = new Map<string, TrackerPlayerTally>(players.map((player) => [player.tag, { ...player, ...emptyTally() }]));
    const h2h = new Map<string, TrackerPairTally>();
    const coPlay = new Map<string, TrackerPairTally>();
    const modes = new Map<string, TrackerModeTally>();
    const cards = new Map<string, TrackerCardTally>();
    const decks = new Map<string, TrackerDeckTally>();
    const opponentCards = new Map<string, TrackerCardTally>();
    const opponentDecks = new Map<string, TrackerDeckTally>();
    const deckMatchups = new Map<string, TrackerDeckMatchupTally>();
    const sample = emptyTally();
    const pairTally = (map: Map<string, TrackerPairTally>, leftTag: string, rightTag: string) => {
      const key = pairKey(leftTag, rightTag);
      const existing = map.get(key);
      if (existing) return existing;
      const [canonicalLeft, canonicalRight] = leftTag < rightTag ? [leftTag, rightTag] : [rightTag, leftTag];
      const created: TrackerPairTally = { leftTag: canonicalLeft, leftDisplayName: playerByTag.get(canonicalLeft)?.displayName ?? canonicalLeft, rightTag: canonicalRight, rightDisplayName: playerByTag.get(canonicalRight)?.displayName ?? canonicalRight, ...emptyTally() };
      map.set(key, created);
      return created;
    };
    for (const battle of battles) {
      const focus = battle.participants.find((participant) => participant.tag === filters.playerTag)!;
      addResult(sample, focus.result);
      for (const participant of battle.participants) {
        const tally = playerTallies.get(participant.tag);
        if (tally) addResult(tally, participant.result);
      }
      const modeKey = `${filters.playerTag}\u0000${battle.mode.id ?? battle.mode.name}`;
      const modeTally = modes.get(modeKey) ?? { playerTag: filters.playerTag, modeId: battle.mode.id, modeName: battle.mode.name, ...emptyTally() };
      addResult(modeTally, focus.result); modes.set(modeKey, modeTally);
      for (const card of focus.cards) {
        const key = `${card.id ?? card.key}\u0000${card.form}`;
        const tally = cards.get(key) ?? { playerTag: filters.playerTag, card: bareCard(card), ...emptyTally() };
        addResult(tally, focus.result); cards.set(key, tally);
      }
      const ownSignature = deckSignature(focus.cards);
      if (ownSignature) {
        const tally = decks.get(ownSignature) ?? { playerTag: filters.playerTag, signature: ownSignature, cards: focus.cards.map(bareCard), ...emptyTally() };
        addResult(tally, focus.result); decks.set(ownSignature, tally);
      }
      const opponents = battle.participants.filter((participant) => participant.side !== focus.side);
      for (const opponent of opponents) {
        for (const card of opponent.cards) {
          const key = `${card.id ?? card.key}\u0000${card.form}`;
          const tally = opponentCards.get(key) ?? { playerTag: filters.playerTag, card: bareCard(card), ...emptyTally() };
          addResult(tally, focus.result); opponentCards.set(key, tally);
        }
        const opposingSignature = deckSignature(opponent.cards);
        if (opposingSignature) {
          const tally = opponentDecks.get(opposingSignature) ?? { playerTag: filters.playerTag, signature: opposingSignature, cards: opponent.cards.map(bareCard), ...emptyTally() };
          addResult(tally, focus.result); opponentDecks.set(opposingSignature, tally);
          if (ownSignature) {
            const key = `${ownSignature}\u0000${opposingSignature}`;
            const matchup = deckMatchups.get(key) ?? { playerTag: filters.playerTag, ownSignature, ownCards: focus.cards.map(bareCard), opponentSignature: opposingSignature, opponentCards: opponent.cards.map(bareCard), ...emptyTally() };
            addResult(matchup, focus.result); deckMatchups.set(key, matchup);
          }
        }
      }
      const tracked = battle.participants.filter((participant) => playerByTag.has(participant.tag));
      for (let index = 0; index < tracked.length; index += 1) for (let other = index + 1; other < tracked.length; other += 1) {
        const left = tracked[index]!; const right = tracked[other]!;
        if (left.tag === right.tag) continue;
        const sameSide = left.side === right.side;
        const tally = pairTally(sameSide ? coPlay : h2h, left.tag, right.tag);
        addResult(tally, tally.leftTag === left.tag ? left.result : right.result);
      }
    }
    const byGames = <T extends TrackerTally>(left: T, right: T) => right.games - left.games || right.losses - left.losses;
    return {
      generatedAt: now(), scope: "rolling_observations",
      completenessNotice: COMPLETENESS_NOTICE,
      poll: getStatus(), filters, filterOptions: { players, modes: [...modeOptions.entries()].map(([key, name]) => ({ key, name })).sort((left, right) => left.name.localeCompare(right.name)) },
      coverage: getCoverage(filters.playerTag, allBattles), sample: finalizeTally(sample),
      players: [...playerTallies.values()].map(finalizeTally).sort(byGames), headToHead: [...h2h.values()].map(finalizeTally).sort(byGames), coPlay: [...coPlay.values()].map(finalizeTally).sort(byGames),
      modes: [...modes.values()].map(finalizeTally).sort(byGames), cards: [...cards.values()].map(finalizeTally).sort(byGames).slice(0, 100), decks: [...decks.values()].map(finalizeTally).sort(byGames).slice(0, 100),
      opponentCards: [...opponentCards.values()].map(finalizeTally).sort(byGames).slice(0, 100), opponentDecks: [...opponentDecks.values()].map(finalizeTally).sort(byGames).slice(0, 100), deckMatchups: [...deckMatchups.values()].map(finalizeTally).sort(byGames).slice(0, 100),
      recentGames: battles.slice(0, MAX_RECENT_BATTLES),
    };
  };

  const getDeckLog = (request: { actorProfileId: string; visibleProfileIds: ReadonlySet<string>; playerTag?: unknown }): TrackerDeckLog => {
    ensureOpen(); reconcileSubscriptions();
    const players = visiblePlayers(request.visibleProfileIds);
    const playerTag = normalizeFilters(players, request.actorProfileId, { playerTag: normalizeTrackerTag(request.playerTag) }).playerTag;
    const entries = new Map<string, TrackerDeckLogEntry>();
    const modesByEntry = new Map<string, Map<string, TrackerDeckLogMode>>();
    let battlesWithDecks = 0;
    for (const battle of visibleBattles(request.actorProfileId, request.visibleProfileIds)) {
      const focus = battle.participants.find((participant) => participant.tag === playerTag);
      // Duels report every round's cards together, so only an exact eight-card list is one deck.
      if (!focus || focus.cards.length !== 8) continue;
      battlesWithDecks += 1;
      const { origin, inferred } = deckOriginOf(battle.deckSelection, battle.mode.name);
      const signature = deckSignature(focus.cards);
      const key = `${origin}\u0000${signature}`;
      let entry = entries.get(key);
      if (!entry) {
        const costs = focus.cards.map((card) => card.elixirCost);
        const elixirKnown = costs.every((cost) => cost !== null);
        entry = { signature, cards: focus.cards.map(bareCard), towerTroop: null, origin, originInferred: true, deckSelections: [], firstUsedAt: battle.battleTime, lastUsedAt: battle.battleTime, averageElixir: elixirKnown ? (costs as number[]).reduce((sum, cost) => sum + cost, 0) / 8 : null, modes: [], ...emptyTally() };
        entries.set(key, entry); modesByEntry.set(key, new Map());
      }
      addResult(entry, focus.result);
      if (!inferred) entry.originInferred = false;
      if (battle.deckSelection && !entry.deckSelections.includes(battle.deckSelection)) entry.deckSelections.push(battle.deckSelection);
      if (battle.battleTime < entry.firstUsedAt) entry.firstUsedAt = battle.battleTime;
      // Battles arrive newest first, so the first tower troop seen is the most recent one.
      if (!entry.towerTroop && focus.supportCards?.[0]) entry.towerTroop = bareCard(focus.supportCards[0]);
      const modes = modesByEntry.get(key)!;
      const modeKey = `${battle.type}\u0000${battle.mode.id ?? battle.mode.name}`;
      const mode = modes.get(modeKey) ?? { modeId: battle.mode.id, modeName: battle.mode.name, type: battle.type, ...emptyTally() };
      addResult(mode, focus.result); modes.set(modeKey, mode);
    }
    const decks = [...entries.entries()].map(([key, entry]) => finalizeTally({ ...entry, deckSelections: entry.deckSelections.sort(), modes: [...modesByEntry.get(key)!.values()].map(finalizeTally).sort((left, right) => right.games - left.games) }))
      .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt)).slice(0, 500);
    return { generatedAt: now(), playerTag, players, battlesWithDecks, decks };
  };

  const getInsights = (request: TrackerInsightsRequest): TrackerInsights => {
    ensureOpen(); reconcileSubscriptions();
    const players = visiblePlayers(request.visibleProfileIds);
    const raw = request.filters ?? {};
    const { playerTag, mode, dateFrom, dateTo } = normalizeFilters(players, request.actorProfileId, { playerTag: raw.playerTag, mode: raw.mode, dateFrom: raw.dateFrom, dateTo: raw.dateTo });
    const rival = normalizeTrackerTag(raw.rivalTag);
    const offset = raw.tzOffsetMinutes;
    const filters: TrackerInsightsFilters = {
      playerTag, rivalTag: rival !== playerTag && players.some((player) => player.tag === rival) ? rival : null, mode, dateFrom, dateTo, includeAssigned: raw.includeAssigned === true,
      tzOffsetMinutes: typeof offset === "number" && Number.isInteger(offset) && Math.abs(offset) <= MAX_TZ_OFFSET_MINUTES ? offset : 0,
    };
    return { generatedAt: now(), completenessNotice: COMPLETENESS_NOTICE, ...buildInsights(playerTag ? visibleBattles(request.actorProfileId, request.visibleProfileIds, playerTag) : [], players, filters) };
  };

  const focusBattles = (request: TrackerPlayerRequest) => {
    ensureOpen(); reconcileSubscriptions();
    const playerTag = normalizeFilters(visiblePlayers(request.visibleProfileIds), request.actorProfileId, { playerTag: normalizeTrackerTag(request.playerTag) }).playerTag;
    return { playerTag, battles: playerTag ? visibleBattles(request.actorProfileId, request.visibleProfileIds, playerTag) : [] };
  };
  const getCardStats = (request: TrackerPlayerRequest): TrackerCardStats => {
    const { playerTag, battles } = focusBattles(request);
    return { generatedAt: now(), playerTag, ...buildCardStats(battles, playerTag) };
  };
  const getDeckRecord = (request: TrackerPlayerRequest & { cards: unknown }): TrackerDeckRecord => {
    const parts = typeof request.cards === "string" ? request.cards.split(",").map((part) => part.trim()) : [];
    const cardIds = parts.filter((part) => /^[1-9]\d{0,9}$/.test(part)).map(Number);
    if (parts.length !== 8 || cardIds.length !== 8 || new Set(cardIds).size !== 8) throw new TrackerError(400, "cards must be eight distinct card ids separated by commas", "INVALID_INPUT");
    const { playerTag, battles } = focusBattles(request);
    return { generatedAt: now(), playerTag, ...buildDeckRecord(battles, playerTag, cardIds) };
  };

  const commandReplay = (actorProfileId: string, commandId: string, action: string, hash: string) => {
    const row = db.prepare("SELECT action,payload_hash,result_id FROM tracker_commands WHERE actor_profile_id = ? AND command_id = ?").get(actorProfileId, commandId) as unknown as CommandRow | undefined;
    if (!row) return null;
    if (row.action !== action || row.payload_hash !== hash) throw new TrackerError(409, "commandId was already used for a different tracker action", "COMMAND_CONFLICT");
    return row.result_id;
  };
  const recordCommand = (actorProfileId: string, commandId: string, action: string, hash: string, resultId: string) => db.prepare("INSERT INTO tracker_commands(actor_profile_id,command_id,action,payload_hash,result_id,created_at) VALUES(?,?,?,?,?,?)").run(actorProfileId, commandId, action, hash, resultId, now());

  const addManualResult = (actorProfileId: string, visibleProfileIds: ReadonlySet<string>, rawInput: unknown): ManualTrackerResultResponse => {
    ensureOpen(); reconcileSubscriptions();
    if (!isRecord(rawInput)) throw new TrackerError(400, "A manual result is required", "INVALID_INPUT");
    const commandId = requireCommandId(rawInput.commandId);
    const teamAProfileIds = requireProfileIds(rawInput.teamAProfileIds, "teamAProfileIds");
    const teamBProfileIds = requireProfileIds(rawInput.teamBProfileIds, "teamBProfileIds");
    const allProfileIds = [...teamAProfileIds, ...teamBProfileIds];
    if (new Set(allProfileIds).size !== allProfileIds.length) throw new TrackerError(400, "A player can only appear once in a result", "INVALID_INPUT");
    if (allProfileIds.some((profileId) => !visibleProfileIds.has(profileId))) throw new TrackerError(403, "Manual results can only include you and visible friends", "TRACKER_FORBIDDEN");
    const playerById = new Map(getRegisteredPlayers().map((player) => [player.profileId, player]));
    if (allProfileIds.some((profileId) => !playerById.has(profileId))) throw new TrackerError(400, "Every manual participant must have a linked Clash profile", "UNLINKED_PLAYER");
    const participantTags = allProfileIds.map((profileId) => playerById.get(profileId)!.tag);
    if (new Set(participantTags).size !== participantTags.length) throw new TrackerError(400, "A Clash player tag can only appear once in a result", "INVALID_INPUT");
    const winner = rawInput.winner;
    if (!new Set(["a", "b", "draw", "unknown"]).has(winner as string)) throw new TrackerError(400, "winner must be a, b, draw, or unknown", "INVALID_INPUT");
    const modeInput = isRecord(rawInput.mode) ? rawInput.mode : {};
    const mode = { id: integer(modeInput.id), name: text(modeInput.name, "Manual result") };
    const type = text(rawInput.type, "manual");
    const timestamp = now();
    const battleTime = normalizeBattleTime(rawInput.battleTime, timestamp);
    const crowns: [number | null, number | null] = [requireCrowns(rawInput.crownsA, "crownsA"), requireCrowns(rawInput.crownsB, "crownsB")];
    const resultForManualSide = (side: 0 | 1): TrackerBattleResult => winner === "unknown" ? "unknown" : winner === "draw" ? "draw" : winner === (side === 0 ? "a" : "b") ? "win" : "loss";
    const manualTeam = (profileIds: string[], side: 0 | 1): TrackerParticipant[] => profileIds.map((profileId) => {
      const player = playerById.get(profileId)!;
      return { profileId, tag: player.tag, name: player.displayName, side, crowns: crowns[side], result: resultForManualSide(side), elixirLeaked: null, cards: [] };
    }).sort((left, right) => left.tag.localeCompare(right.tag));
    let teams: [TrackerParticipant[], TrackerParticipant[]] = [manualTeam(teamAProfileIds, 0), manualTeam(teamBProfileIds, 1)];
    if (canonicalTeamSignatures(teams)[0]! > canonicalTeamSignatures(teams)[1]!) teams = [teams[1].map((participant) => ({ ...participant, side: 0 })), teams[0].map((participant) => ({ ...participant, side: 1 }))];
    const coreKey = canonicalBattleKey(battleTime, type, mode.id, mode.name, teams);
    const dedupeKey = `manual:${coreKey}`;
    const provenance: TrackerBattleProvenance = { kind: "manual", label: "Manual tally", observedAt: timestamp };
    const battle: NormalizedBattle = { id: `manual_${coreKey.slice(0, 24)}`, dedupeKey, battleTime, type, mode, source: "manual", unit: /duel/i.test(`${type} ${mode.name}`) ? "duel_round" : "match", fetchedAt: timestamp, provenance, participants: teams.flat() };
    const action = "manual.add";
    const hash = payloadHash({ battleTime, type, mode, teamAProfileIds, teamBProfileIds, winner, crowns });
    let replayed = false; let resultId = battle.id;
    transaction(() => {
      const replay = commandReplay(actorProfileId, commandId, action, hash);
      if (replay) { replayed = true; resultId = replay; return; }
      resultId = insertBattle(battle, actorProfileId, [playerById.get(actorProfileId)?.tag ?? "#UNKNOWN"]).id;
      recordCommand(actorProfileId, commandId, action, hash, resultId);
    });
    return { battle: readBattle(resultId), replayed };
  };

  const undoManualResult = (actorProfileId: string, visibleProfileIds: ReadonlySet<string>, rawBattleId: unknown, rawInput: unknown): UndoManualTrackerResultResponse => {
    ensureOpen();
    if (typeof rawBattleId !== "string" || !rawBattleId.trim()) throw new TrackerError(400, "battleId is required", "INVALID_INPUT");
    if (!isRecord(rawInput)) throw new TrackerError(400, "An undo command is required", "INVALID_INPUT");
    const battleId = rawBattleId.trim(); const commandId = requireCommandId(rawInput.commandId);
    const action = `manual.undo:${battleId}`; const hash = payloadHash({ battleId });
    let replayed = false; let undone = false;
    transaction(() => {
      if (commandReplay(actorProfileId, commandId, action, hash)) { replayed = true; return; }
      const row = db.prepare("SELECT source,created_by FROM tracker_battles WHERE id=?").get(battleId) as { source: string; created_by: string | null } | undefined;
      if (!row) throw new TrackerError(404, "Tracked game was not found", "NOT_FOUND");
      if (row.source !== "manual") throw new TrackerError(409, "API games cannot be undone manually", "API_GAME_IMMUTABLE");
      if (row.created_by !== actorProfileId) throw new TrackerError(403, "Only the person who entered this result can undo it", "TRACKER_FORBIDDEN");
      if (!visibleProfileIds.has(actorProfileId)) throw new TrackerError(403, "This result is outside your visible tracker scope", "TRACKER_FORBIDDEN");
      undone = Number(db.prepare("UPDATE tracker_battles SET undone_at=? WHERE id=? AND undone_at IS NULL").run(now(), battleId).changes) > 0;
      recordCommand(actorProfileId, commandId, action, hash, battleId);
    });
    return { battleId, undone, replayed };
  };

  const storeRawResponse = (tag: string, fetchedAt: number, body: string) => {
    const hash = sha256(body); const bytes = Buffer.byteLength(body);
    db.prepare("INSERT OR IGNORE INTO tracker_raw_responses(id,player_tag,fetched_at,payload_sha256,raw_bytes,payload_json) VALUES(?,?,?,?,?,?)").run(`raw_${sha256(`${tag}:${fetchedAt}:${hash}`).slice(0, 24)}`, tag, fetchedAt, hash, bytes, bytes <= MAX_RAW_BODY_BYTES ? body : null);
    db.prepare(`DELETE FROM tracker_raw_responses WHERE player_tag=? AND id NOT IN
      (SELECT id FROM tracker_raw_responses WHERE player_tag=? ORDER BY fetched_at DESC LIMIT 2)`).run(tag, tag);
  };

  const fetchBattlelog = async (tag: string, displayName: string, fetchedAt: number) => {
    const controller = new AbortController(); activeControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(`${apiBaseUrl}/players/${encodeURIComponent(tag)}/battlelog`, { headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" }, signal: controller.signal });
      if (!response.ok) {
        const retry = response.headers.get("retry-after");
        const seconds = retry === null ? Number.NaN : Number(retry);
        const dateDelay = retry && !Number.isFinite(seconds) ? Date.parse(retry) - fetchedAt : Number.NaN;
        const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(MAX_BACKOFF_MS, seconds * 1_000) : Number.isFinite(dateDelay) && dateDelay > 0 ? Math.min(MAX_BACKOFF_MS, dateDelay) : null;
        throw new ApiPollError(`Clash API returned ${response.status} for ${displayName}`, retryAfterMs);
      }
      const body = await response.text();
      if (Buffer.byteLength(body) > MAX_API_BODY_BYTES) throw new ApiPollError(`Clash API response for ${displayName} was too large`);
      let parsed: unknown; try { parsed = JSON.parse(body); } catch { throw new ApiPollError(`Clash API returned unreadable data for ${displayName}`); }
      if (!Array.isArray(parsed)) throw new ApiPollError(`Clash API returned an invalid battle log for ${displayName}`);
      const provenance: TrackerBattleProvenance = { kind: "server_fetch", label: "Clash Royale API", observedAt: fetchedAt };
      const battles = parsed.slice(0, MAX_BATTLES_PER_RESPONSE).flatMap((battle) => { const normalized = normalizeApiBattle(battle, fetchedAt, provenance); return normalized ? [normalized] : []; });
      return { battles, body };
    } catch (error) {
      if (error instanceof ApiPollError) throw error;
      if ((error instanceof DOMException || error instanceof Error) && error.name === "AbortError") throw new ApiPollError(`Clash API timed out for ${displayName}`);
      throw new ApiPollError(`Clash API could not be reached for ${displayName}`);
    } finally { clearTimeout(timeout); activeControllers.delete(controller); }
  };

  // The profile's lifetime counters are the only independent check on the rolling battle log, and they date trophy progress.
  const snapshotProfile = async (tag: string, fetchedAt: number) => {
    const controller = new AbortController(); activeControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(`${apiBaseUrl}/players/${encodeURIComponent(tag)}`, { headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" }, signal: controller.signal });
      if (!response.ok) return;
      const profile: unknown = JSON.parse(await response.text());
      if (!isRecord(profile) || normalizeTrackerTag(profile.tag) !== tag || closed) return;
      const counters = [integer(profile.battleCount), integer(profile.wins), integer(profile.losses), integer(profile.threeCrownWins), integer(profile.trophies)];
      const latest = db.prepare("SELECT fetched_at,battle_count,wins,losses,three_crown_wins,trophies FROM tracker_profile_snapshots WHERE player_tag=? ORDER BY fetched_at DESC LIMIT 1").get(tag) as { fetched_at: number; battle_count: number | null; wins: number | null; losses: number | null; three_crown_wins: number | null; trophies: number | null } | undefined;
      if (latest && [latest.battle_count, latest.wins, latest.losses, latest.three_crown_wins, latest.trophies].every((value, index) => value === counters[index])) {
        db.prepare("UPDATE tracker_profile_snapshots SET last_seen_at=? WHERE player_tag=? AND fetched_at=?").run(fetchedAt, tag, latest.fetched_at);
        return;
      }
      const pathOfLegend = isRecord(profile.currentPathOfLegendSeasonResult) ? JSON.stringify(profile.currentPathOfLegendSeasonResult) : null;
      db.prepare(`INSERT OR IGNORE INTO tracker_profile_snapshots(player_tag,fetched_at,last_seen_at,battle_count,wins,losses,three_crown_wins,trophies,best_trophies,exp_level,path_of_legend_json,current_deck_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(tag, fetchedAt, fetchedAt, ...counters, integer(profile.bestTrophies), integer(profile.expLevel), pathOfLegend, JSON.stringify(parseCards(profile.currentDeck)));
    } catch { /* A missed profile snapshot never blocks battle collection; the next poll retries. */ }
    finally { clearTimeout(timeout); activeControllers.delete(controller); }
  };
  const profileSnapshotDue = (tag: string, insertedCount: number) => {
    const latest = db.prepare("SELECT max(last_seen_at) AS seen FROM tracker_profile_snapshots WHERE player_tag=?").get(tag) as { seen: number | null };
    return insertedCount > 0 || latest.seen === null || now() - latest.seen >= PROFILE_SNAPSHOT_IDLE_MS;
  };

  const getBattleCountAudit = (visibleProfileIds: ReadonlySet<string>, rawTag: unknown): TrackerBattleCountAudit => {
    ensureOpen();
    const tag = normalizeTrackerTag(rawTag);
    if (!tag || !visibleTags(visibleProfileIds).has(tag)) throw new TrackerError(403, "That player is outside your visible tracker scope", "TRACKER_FORBIDDEN");
    const snapshots = db.prepare("SELECT fetched_at,battle_count,wins,losses FROM tracker_profile_snapshots WHERE player_tag=? AND battle_count IS NOT NULL ORDER BY fetched_at").all(tag) as Array<{ fetched_at: number; battle_count: number; wins: number | null; losses: number | null }>;
    const first = snapshots[0]; const last = snapshots.at(-1);
    if (!first || !last || first === last) return { playerTag: tag, fromAt: first?.fetched_at ?? null, toAt: last?.fetched_at ?? null, battleCountDelta: null, winsDelta: null, lossesDelta: null, recordedByType: [] };
    const rows = db.prepare(`SELECT b.type AS type,count(*) AS games FROM tracker_battles b JOIN tracker_participants p ON p.battle_id=b.id
      WHERE p.player_tag=? AND b.source='api' AND b.battle_time > ? AND b.battle_time <= ? GROUP BY b.type ORDER BY games DESC`)
      .all(tag, new Date(first.fetched_at).toISOString(), new Date(last.fetched_at).toISOString()) as Array<{ type: string; games: number }>;
    const delta = (left: number | null, right: number | null) => left === null || right === null ? null : right - left;
    return { playerTag: tag, fromAt: first.fetched_at, toAt: last.fetched_at, battleCountDelta: last.battle_count - first.battle_count, winsDelta: delta(first.wins, last.wins), lossesDelta: delta(first.losses, last.losses), recordedByType: rows.map((row) => ({ type: row.type, games: Number(row.games) })) };
  };

  const jitter = (delay: number) => Math.max(10_000, Math.round(delay * (1 + (random() * 2 - 1) * jitterRatio)));
  const recordAttempt = (tag: string, attemptedAt: number, completedAt: number, success: boolean, responseCount: number, insertedCount: number, oldest: string | null, newest: string | null, error: string | null, retryAfterMs: number | null, possibleGap: boolean) => {
    db.prepare(`INSERT INTO tracker_poll_attempts(id,player_tag,attempted_at,completed_at,success,response_count,inserted_count,window_oldest,window_newest,error,retry_after_ms,possible_gap)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(`attempt_${sha256(`${tag}:${attemptedAt}:${completedAt}`).slice(0, 24)}`, tag, attemptedAt, completedAt, success ? 1 : 0, responseCount, insertedCount, oldest, newest, error, retryAfterMs, possibleGap ? 1 : 0);
    db.prepare(`DELETE FROM tracker_poll_attempts WHERE player_tag=? AND id NOT IN
      (SELECT id FROM tracker_poll_attempts WHERE player_tag=? ORDER BY attempted_at DESC LIMIT 250)`).run(tag, tag);
  };

  const pollTag = async (tag: string, displayName: string) => {
    if (pollingTags.has(tag) || closed) return;
    pollingTags.add(tag); const attemptedAt = now(); lastPollAt = attemptedAt;
    const prior = db.prepare("SELECT * FROM tracker_tag_poll_state WHERE player_tag=?").get(tag) as unknown as PollRow;
    try {
      const { battles, body } = await fetchBattlelog(tag, displayName, attemptedAt);
      let insertedCount = 0;
      const keys = battles.map((battle) => battle.dedupeKey);
      const times = battles.map((battle) => battle.battleTime).sort();
      const oldest = times[0] ?? null; const newest = times.at(-1) ?? null;
      const priorKeys = new Set(safeJson<string[]>(prior?.last_window_keys_json ?? "[]", []));
      const overlap = keys.some((key) => priorKeys.has(key));
      const possibleGap = Boolean(oldest && newest && prior?.last_window_newest && !overlap && oldest > prior.last_window_newest);
      transaction(() => {
        storeRawResponse(tag, attemptedAt, body);
        for (const battle of battles) if (insertBattle(battle, null, [tag]).inserted) insertedCount += 1;
        if (possibleGap) db.prepare("INSERT OR IGNORE INTO tracker_coverage_gaps(player_tag,gap_start,gap_end,detected_at,reason) VALUES(?,?,?,?,?)").run(tag, prior.last_window_newest, oldest, now(), "non_overlapping_api_windows");
        const active = insertedCount > 0 || Boolean(newest && now() - Date.parse(newest) <= ACTIVE_WINDOW_MS);
        const idleStreak = active ? 0 : Math.min((prior?.idle_streak ?? 0) + 1, 8);
        const delay = active ? quickPollMs : Math.min(maxIdlePollMs, quickPollMs * 2 ** Math.min(idleStreak, 4));
        const next = now() + jitter(delay);
        db.prepare(`UPDATE tracker_tag_poll_state SET display_name=?,last_attempt_at=?,last_success_at=?,next_poll_at=?,last_error=NULL,
          battles_seen=?,consecutive_failures=0,idle_streak=?,possible_gap_count=possible_gap_count+?,last_window_oldest=?,last_window_newest=?,last_window_keys_json=? WHERE player_tag=?`)
          .run(displayName, attemptedAt, now(), next, battles.length, idleStreak, possibleGap ? 1 : 0, oldest ?? prior?.last_window_oldest ?? null, newest ?? prior?.last_window_newest ?? null, keys.length ? JSON.stringify(keys.slice(0, 100)) : prior?.last_window_keys_json ?? "[]", tag);
        recordAttempt(tag, attemptedAt, now(), true, battles.length, insertedCount, oldest, newest, null, null, possibleGap);
      });
      if (profileSnapshotDue(tag, insertedCount)) await snapshotProfile(tag, now());
    } catch (error) {
      const failure = error instanceof ApiPollError ? error : new ApiPollError("Clash API polling failed");
      const failures = Math.min((prior?.consecutive_failures ?? 0) + 1, 8);
      const delay = Math.max(failure.retryAfterMs ?? 0, Math.min(MAX_BACKOFF_MS, quickPollMs * 2 ** failures));
      transaction(() => {
        db.prepare("UPDATE tracker_tag_poll_state SET display_name=?,last_attempt_at=?,next_poll_at=?,last_error=?,consecutive_failures=? WHERE player_tag=?").run(displayName, attemptedAt, now() + jitter(delay), failure.message, failures, tag);
        recordAttempt(tag, attemptedAt, now(), false, 0, 0, null, null, failure.message, failure.retryAfterMs, false);
      });
    } finally { pollingTags.delete(tag); }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!autoStart || closed || !apiToken) return;
    const players = activeTags();
    if (!players.length) return;
    const stateRows = db.prepare("SELECT player_tag,next_poll_at FROM tracker_tag_poll_state").all() as Array<{ player_tag: string; next_poll_at: number | null }>;
    const byTag = new Map(stateRows.map((row) => [row.player_tag, row.next_poll_at]));
    const next = Math.min(...players.map((player) => byTag.get(player.tag) ?? now()));
    timer = setTimeout(() => {
      timer = null;
      const dueAt = now();
      const due = players.filter((player) => (byTag.get(player.tag) ?? 0) <= dueAt);
      void Promise.allSettled(due.map((player) => pollTag(player.tag, player.displayName))).then(schedule);
    }, Math.max(25, next - now()));
    timer.unref?.();
  };

  const syncNow = async (tags?: readonly string[]) => {
    ensureOpen();
    if (!apiToken) return getStatus();
    const requested = tags ? new Set(tags.map(normalizeTrackerTag)) : null;
    const players = activeTags().filter((player) => !requested || requested.has(player.tag));
    await Promise.allSettled(players.map((player) => pollTag(player.tag, player.displayName)));
    schedule();
    return getStatus();
  };

  const requestSync = async (actorProfileId: string, visibleProfileIds: ReadonlySet<string>, rawTag?: unknown) => {
    ensureOpen(); reconcileSubscriptions();
    const allowed = visibleTags(visibleProfileIds);
    const own = getRegisteredPlayers().find((player) => player.profileId === actorProfileId)?.tag;
    const tag = normalizeTrackerTag(rawTag) || own || "";
    if (!tag || !allowed.has(tag)) throw new TrackerError(403, "That player is outside your visible tracker scope", "TRACKER_FORBIDDEN");
    const activeInScope = visiblePlayers(visibleProfileIds).find((player) => player.tag === tag)?.activeProfileIds.length;
    if (!activeInScope) throw new TrackerError(409, "That historical player tag is no longer tracked. Reconnect it in account settings before syncing.", "TRACKING_INACTIVE");
    const last = manualSyncAt.get(tag) ?? 0;
    if (now() - last < MANUAL_SYNC_COOLDOWN_MS) throw new TrackerError(429, "That player was just queued for sync. Try again shortly.", "SYNC_COOLDOWN");
    manualSyncAt.set(tag, now());
    return syncNow([tag]);
  };

  const importHistorical = (parsed: ParsedHistoricalImport, kind: "operator_snapshot" | "user_import", label?: string): TrackerImportResult => {
    ensureOpen();
    let insertedRows = 0; let duplicateRows = 0;
    transaction(() => {
      for (const entry of parsed.battles) {
        const battle = { ...entry.battle, provenance: { kind, label: (label || parsed.sourceLabel).slice(0, 160), observedAt: entry.battle.provenance.observedAt } } satisfies NormalizedBattle;
        if (insertBattle(battle, null, entry.observedTags).inserted) insertedRows += 1; else duplicateRows += 1;
      }
    });
    return { inputRows: parsed.inputRows, validRows: parsed.battles.length, uniqueRows: parsed.battles.length, insertedRows, duplicateRows, rejectedRows: parsed.rejectedRows, earliestBattleAt: parsed.earliestBattleAt, latestBattleAt: parsed.latestBattleAt, provenanceKind: kind };
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    for (const controller of activeControllers) controller.abort();
    activeControllers.clear(); pollingTags.clear(); db.close();
  };

  reconcileSubscriptions();
  if (autoStart && apiToken) schedule();
  return { getRegisteredPlayers, getStatus, getSummary, syncNow, requestSync, getBattleCountAudit, getDeckLog, getInsights, getCardStats, getDeckRecord, importHistorical, addManualResult, undoManualResult, close };
};
