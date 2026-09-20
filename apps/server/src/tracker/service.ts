import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ManualTrackerResultResponse,
  TrackerBattle,
  TrackerBattleResult,
  TrackerCard,
  TrackerCardTally,
  TrackerCardForm,
  TrackerDeckTally,
  TrackerModeTally,
  TrackerPairTally,
  TrackerParticipant,
  TrackerPlayerTally,
  TrackerPollPlayerStatus,
  TrackerPollStatus,
  TrackerSummary,
  TrackerTally,
  UndoManualTrackerResultResponse,
} from "@draft-royale/shared";

const DEFAULT_API_BASE_URL = "https://proxy.royaleapi.dev/v1";
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const MAX_API_BODY_BYTES = 5 * 1024 * 1024;
const MAX_BATTLES_PER_RESPONSE = 100;
const MAX_RECENT_BATTLES = 50;

type UnknownRecord = Record<string, unknown>;

interface BattleRow {
  id: string;
  battle_time: string;
  type: string;
  mode_id: number | null;
  mode_name: string;
  source: "api" | "manual";
  fetched_at: number;
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
}

interface CommandRow {
  action: string;
  payload_hash: string;
  result_id: string;
}

interface PollRow {
  profile_id: string;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  battles_seen: number;
}

interface NormalizedBattle extends TrackerBattle {
  dedupeKey: string;
}

export interface TrackerRegisteredPlayer {
  profileId: string;
  displayName: string;
  tag: string;
}

export interface TrackerServiceOptions {
  databasePath: string;
  getPlayers: () => TrackerRegisteredPlayer[];
  apiToken?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  autoStart?: boolean;
}

export interface TrackerService {
  getRegisteredPlayers(): TrackerRegisteredPlayer[];
  getStatus(): TrackerPollStatus;
  getSummary(visibleProfileIds: ReadonlySet<string>): TrackerSummary;
  syncNow(): Promise<TrackerPollStatus>;
  addManualResult(actorProfileId: string, visibleProfileIds: ReadonlySet<string>, input: unknown): ManualTrackerResultResponse;
  undoManualResult(actorProfileId: string, visibleProfileIds: ReadonlySet<string>, battleId: unknown, input: unknown): UndoManualTrackerResultResponse;
  close(): void;
}

export class TrackerError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) {
    super(message);
  }
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
const normalizeTag = (value: unknown) => {
  const normalized = text(value).toUpperCase().replace(/\s+/g, "");
  if (!normalized) return "";
  return normalized.startsWith("#") ? normalized : `#${normalized}`;
};
const normalizePlayer = (player: TrackerRegisteredPlayer): TrackerRegisteredPlayer => ({
  profileId: player.profileId.trim(),
  displayName: player.displayName.trim(),
  tag: normalizeTag(player.tag),
});
const slugifyCardName = (name: string) => name.toLowerCase().replace(/[.']/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const clone = <T>(value: T): T => structuredClone(value);

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
  // In current battle payloads evolutionLevel is a bit field: 1 = Evo, 2 = Hero.
  // Keep the legacy explicit fields as fallbacks, but never treat bit 2 as Evo.
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
  return [{
    id: integer(candidate.id),
    key: slugifyCardName(name) || `card-${integer(candidate.id) ?? "unknown"}`,
    name,
    form: parseCardForm(candidate),
    elixirCost: finite(candidate.elixirCost),
  } satisfies TrackerCard];
}) : [];

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

const parseApiParticipants = (value: unknown, side: 0 | 1, playerByTag: ReadonlyMap<string, TrackerRegisteredPlayer>): TrackerParticipant[] =>
  (Array.isArray(value) ? value : []).slice(0, 4).flatMap((candidate, position) => {
    if (!isRecord(candidate)) return [];
    const name = text(candidate.name, "Unknown player");
    const tag = normalizeTag(candidate.tag) || `UNKNOWN-${slugifyCardName(name) || "PLAYER"}-${side}-${position}`;
    return [{
      profileId: playerByTag.get(tag)?.profileId ?? null,
      tag,
      name,
      side,
      crowns: integer(candidate.crowns),
      result: "unknown" as const,
      elixirLeaked: finite(candidate.elixirLeaked),
      cards: parseCards(candidate.cards),
    }];
  }).sort((left, right) => left.tag.localeCompare(right.tag));

export const normalizeApiBattle = (value: unknown, fetchedAt: number, players: TrackerRegisteredPlayer[]): NormalizedBattle | null => {
  if (!isRecord(value)) return null;
  const playerByTag = new Map(players.map((player) => [player.tag, player]));
  const battleTime = normalizeBattleTime(value.battleTime, fetchedAt);
  const type = text(value.type, "unknown");
  const gameMode = isRecord(value.gameMode) ? value.gameMode : {};
  const mode = { id: integer(gameMode.id), name: text(gameMode.name, "Unknown mode") };
  let teams: [TrackerParticipant[], TrackerParticipant[]] = [
    parseApiParticipants(value.team, 0, playerByTag),
    parseApiParticipants(value.opponent, 1, playerByTag),
  ];
  if (teams[0].length === 0 || teams[1].length === 0) return null;
  const initialSignatures = canonicalTeamSignatures(teams);
  if (initialSignatures[0]! > initialSignatures[1]!) {
    teams = [
      teams[1].map((participant) => ({ ...participant, side: 0 })),
      teams[0].map((participant) => ({ ...participant, side: 1 })),
    ];
  }
  const teamCrowns = teams.map((team) => {
    const values = team.map((participant) => participant.crowns);
    return values.some((crowns) => crowns === null) ? null : Math.max(...values as number[]);
  }) as [number | null, number | null];
  teams = teams.map((team, side) => team.map((participant) => ({ ...participant, side: side as 0 | 1, result: resultForSide(side as 0 | 1, teamCrowns) }))) as typeof teams;
  const dedupeKey = canonicalBattleKey(battleTime, type, mode.id, mode.name, teams);
  return {
    id: `api_${dedupeKey.slice(0, 24)}`,
    dedupeKey,
    battleTime,
    type,
    mode,
    source: "api",
    fetchedAt,
    participants: teams.flat(),
  };
};

const emptyTally = (): TrackerTally => ({ games: 0, wins: 0, losses: 0, draws: 0, unknown: 0, winRate: null });
const addResult = <T extends TrackerTally>(tally: T, result: TrackerBattleResult) => {
  tally.games += 1;
  if (result === "win") tally.wins += 1;
  else if (result === "loss") tally.losses += 1;
  else if (result === "draw") tally.draws += 1;
  else tally.unknown += 1;
};
const finalizeTally = <T extends TrackerTally>(tally: T): T => {
  const decided = tally.wins + tally.losses + tally.draws;
  tally.winRate = decided > 0 ? tally.wins / decided : null;
  return tally;
};
const pairKey = (left: string, right: string) => left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;

const requireCommandId = (value: unknown) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100) throw new TrackerError(400, "commandId is required", "INVALID_INPUT");
  return value.trim();
};
const requireProfileIds = (value: unknown, label: string) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new TrackerError(400, `${label} must contain one or two player profiles`, "INVALID_INPUT");
  }
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
  const pollIntervalMs = Math.max(10_000, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const autoStart = options.autoStart ?? true;
  if (options.databasePath !== ":memory:") fs.mkdirSync(path.dirname(options.databasePath), { recursive: true });
  const db = new DatabaseSync(options.databasePath);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracker_battles (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      battle_time TEXT NOT NULL,
      type TEXT NOT NULL,
      mode_id INTEGER,
      mode_name TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('api','manual')),
      fetched_at INTEGER NOT NULL,
      created_by TEXT,
      undone_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS tracker_participants (
      battle_id TEXT NOT NULL,
      side INTEGER NOT NULL CHECK (side IN (0,1)),
      position INTEGER NOT NULL,
      profile_id TEXT,
      player_tag TEXT NOT NULL,
      player_name TEXT NOT NULL,
      crowns INTEGER,
      result TEXT NOT NULL CHECK (result IN ('win','loss','draw','unknown')),
      elixir_leaked REAL,
      cards_json TEXT NOT NULL,
      PRIMARY KEY (battle_id, side, position),
      FOREIGN KEY (battle_id) REFERENCES tracker_battles(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS tracker_commands (
      actor_profile_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      result_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (actor_profile_id, command_id)
    );
    CREATE TABLE IF NOT EXISTS tracker_poll_state (
      profile_id TEXT PRIMARY KEY,
      last_attempt_at INTEGER,
      last_success_at INTEGER,
      last_error TEXT,
      battles_seen INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS tracker_battles_time ON tracker_battles(battle_time DESC);
    CREATE INDEX IF NOT EXISTS tracker_participants_profile ON tracker_participants(profile_id, battle_id);
  `);

  let closed = false;
  let polling = false;
  let consecutiveFailures = 0;
  let lastPollAt: number | null = null;
  let nextPollAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const activeControllers = new Set<AbortController>();

  const ensureOpen = () => {
    if (closed) throw new TrackerError(503, "Game tracker is closed", "SERVICE_CLOSED");
  };
  const getRegisteredPlayers = () => options.getPlayers().map(normalizePlayer).filter((player) => player.profileId && player.displayName && /^#[0289PYLQGRJCUV]+$/i.test(player.tag));
  const transaction = <T>(operation: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const insertBattle = (battle: NormalizedBattle, createdBy: string | null) => {
    const inserted = db.prepare(`INSERT OR IGNORE INTO tracker_battles
      (id,dedupe_key,battle_time,type,mode_id,mode_name,source,fetched_at,created_by,undone_at)
      VALUES(?,?,?,?,?,?,?,?,?,NULL)`)
      .run(battle.id, battle.dedupeKey, battle.battleTime, battle.type, battle.mode.id, battle.mode.name, battle.source, battle.fetchedAt, createdBy);
    if (Number(inserted.changes) === 0) {
      const existing = db.prepare("SELECT id FROM tracker_battles WHERE dedupe_key = ?").get(battle.dedupeKey) as { id: string } | undefined;
      return { inserted: false, id: existing?.id ?? battle.id };
    }
    const statement = db.prepare(`INSERT INTO tracker_participants
      (battle_id,side,position,profile_id,player_tag,player_name,crowns,result,elixir_leaked,cards_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)`);
    for (const side of [0, 1] as const) {
      const participants = battle.participants.filter((participant) => participant.side === side).sort((left, right) => left.tag.localeCompare(right.tag));
      participants.forEach((participant, position) => statement.run(
        battle.id, side, position, participant.profileId, participant.tag, participant.name, participant.crowns,
        participant.result, participant.elixirLeaked, JSON.stringify(participant.cards),
      ));
    }
    return { inserted: true, id: battle.id };
  };

  const readBattle = (battleId: string): TrackerBattle => {
    const row = db.prepare("SELECT id,battle_time,type,mode_id,mode_name,source,fetched_at FROM tracker_battles WHERE id = ?").get(battleId) as unknown as BattleRow | undefined;
    if (!row) throw new TrackerError(404, "Tracked game was not found", "NOT_FOUND");
    const participantRows = db.prepare(`SELECT battle_id,side,position,profile_id,player_tag,player_name,crowns,result,elixir_leaked,cards_json
      FROM tracker_participants WHERE battle_id = ? ORDER BY side,position`).all(row.id) as unknown as ParticipantRow[];
    return {
      id: row.id,
      battleTime: row.battle_time,
      type: row.type,
      mode: { id: row.mode_id, name: row.mode_name },
      source: row.source,
      fetchedAt: row.fetched_at,
      participants: participantRows.map((participant) => ({
        profileId: participant.profile_id,
        tag: participant.player_tag,
        name: participant.player_name,
        side: participant.side,
        crowns: participant.crowns,
        result: participant.result,
        elixirLeaked: participant.elixir_leaked,
        cards: JSON.parse(participant.cards_json) as TrackerCard[],
      })),
    };
  };

  const visibleBattles = (visibleProfileIds: ReadonlySet<string>) => {
    const rows = db.prepare(`SELECT id,battle_time,type,mode_id,mode_name,source,fetched_at FROM tracker_battles
      WHERE undone_at IS NULL ORDER BY battle_time DESC`).all() as unknown as BattleRow[];
    if (rows.length === 0 || visibleProfileIds.size === 0) return [];
    const participants = db.prepare(`SELECT battle_id,side,position,profile_id,player_tag,player_name,crowns,result,elixir_leaked,cards_json
      FROM tracker_participants WHERE battle_id IN (SELECT id FROM tracker_battles WHERE undone_at IS NULL)
      ORDER BY battle_id,side,position`).all() as unknown as ParticipantRow[];
    const byBattle = new Map<string, TrackerParticipant[]>();
    for (const participant of participants) {
      const projected: TrackerParticipant = {
        profileId: participant.profile_id,
        tag: participant.player_tag,
        name: participant.player_name,
        side: participant.side,
        crowns: participant.crowns,
        result: participant.result,
        elixirLeaked: participant.elixir_leaked,
        cards: JSON.parse(participant.cards_json) as TrackerCard[],
      };
      const existing = byBattle.get(participant.battle_id) ?? [];
      existing.push(projected);
      byBattle.set(participant.battle_id, existing);
    }
    return rows.flatMap((row) => {
      const battleParticipants = byBattle.get(row.id) ?? [];
      if (!battleParticipants.some((participant) => participant.profileId !== null && visibleProfileIds.has(participant.profileId))) return [];
      return [{
        id: row.id,
        battleTime: row.battle_time,
        type: row.type,
        mode: { id: row.mode_id, name: row.mode_name },
        source: row.source,
        fetchedAt: row.fetched_at,
        participants: battleParticipants,
      } satisfies TrackerBattle];
    });
  };

  const projectPollPlayers = (): TrackerPollPlayerStatus[] => {
    const rows = db.prepare("SELECT profile_id,last_attempt_at,last_success_at,last_error,battles_seen FROM tracker_poll_state").all() as unknown as PollRow[];
    const byProfile = new Map(rows.map((row) => [row.profile_id, row]));
    return getRegisteredPlayers().map((player) => {
      const row = byProfile.get(player.profileId);
      return {
        ...player,
        lastAttemptAt: row?.last_attempt_at ?? null,
        lastSuccessAt: row?.last_success_at ?? null,
        lastError: row?.last_error ?? null,
        battlesSeen: row?.battles_seen ?? 0,
      };
    });
  };

  const getStatus = (): TrackerPollStatus => {
    if (closed) return {
      configured: Boolean(apiToken), state: "closed", lastPollAt, lastSuccessfulPollAt: null,
      nextPollAt: null, stale: true, message: "Game tracker is closed.", players: [],
    };
    const players = projectPollPlayers();
    const successful = players.map((player) => player.lastSuccessAt).filter((value): value is number => value !== null);
    const lastSuccessfulPollAt = successful.length > 0 ? Math.max(...successful) : null;
    const stale = lastSuccessfulPollAt === null || now() - lastSuccessfulPollAt > Math.max(5 * 60_000, pollIntervalMs * 3);
    const state = closed ? "closed" : !apiToken ? "missing_token" : polling ? "polling" : consecutiveFailures > 0 ? "backoff" : "ready";
    const message = !apiToken
      ? "Automatic history is off until CLASH_ROYALE_API_TOKEN is configured. Manual results remain available."
      : stale
        ? "The local history is empty or stale. It will update from the API's recent rolling battle log."
        : "Showing locally recorded observations from the API's recent rolling battle log.";
    return { configured: Boolean(apiToken), state, lastPollAt, lastSuccessfulPollAt, nextPollAt, stale, message, players };
  };

  const getSummary = (visibleProfileIds: ReadonlySet<string>): TrackerSummary => {
    ensureOpen();
    const registered = getRegisteredPlayers().filter((player) => visibleProfileIds.has(player.profileId));
    const playerById = new Map(registered.map((player) => [player.profileId, player]));
    const battles = visibleBattles(visibleProfileIds);
    const playerTallies = new Map<string, TrackerPlayerTally>(registered.map((player) => [player.profileId, { ...player, ...emptyTally() }]));
    const h2h = new Map<string, TrackerPairTally>();
    const coPlay = new Map<string, TrackerPairTally>();
    const modes = new Map<string, TrackerModeTally>();
    const cards = new Map<string, TrackerCardTally>();
    const decks = new Map<string, TrackerDeckTally>();

    const pairTally = (map: Map<string, TrackerPairTally>, leftId: string, rightId: string) => {
      const key = pairKey(leftId, rightId);
      const existing = map.get(key);
      if (existing) return existing;
      const [canonicalLeft, canonicalRight] = leftId < rightId ? [leftId, rightId] : [rightId, leftId];
      const created: TrackerPairTally = {
        leftProfileId: canonicalLeft,
        leftDisplayName: playerById.get(canonicalLeft)?.displayName ?? canonicalLeft,
        rightProfileId: canonicalRight,
        rightDisplayName: playerById.get(canonicalRight)?.displayName ?? canonicalRight,
        ...emptyTally(),
      };
      map.set(key, created);
      return created;
    };

    for (const battle of battles) {
      const tracked = battle.participants.filter((participant): participant is TrackerParticipant & { profileId: string } =>
        participant.profileId !== null && visibleProfileIds.has(participant.profileId));
      for (const participant of tracked) {
        const playerTally = playerTallies.get(participant.profileId);
        if (playerTally) addResult(playerTally, participant.result);
        const modeKey = `${participant.profileId}\u0000${battle.mode.id ?? battle.mode.name}`;
        const modeTally = modes.get(modeKey) ?? {
          profileId: participant.profileId,
          modeId: battle.mode.id,
          modeName: battle.mode.name,
          ...emptyTally(),
        };
        addResult(modeTally, participant.result);
        modes.set(modeKey, modeTally);
        for (const card of participant.cards) {
          const cardKey = `${participant.profileId}\u0000${card.id ?? card.key}\u0000${card.form}`;
          const cardTally = cards.get(cardKey) ?? { profileId: participant.profileId, card: clone(card), ...emptyTally() };
          addResult(cardTally, participant.result);
          cards.set(cardKey, cardTally);
        }
        if (participant.cards.length > 0) {
          const orderedCards = [...participant.cards].sort((left, right) => `${left.id ?? left.key}:${left.form}`.localeCompare(`${right.id ?? right.key}:${right.form}`));
          const signature = orderedCards.map((card) => `${card.id ?? card.key}:${card.form}`).join("|");
          const deckKey = `${participant.profileId}\u0000${signature}`;
          const deckTally = decks.get(deckKey) ?? { profileId: participant.profileId, signature, cards: orderedCards, ...emptyTally() };
          addResult(deckTally, participant.result);
          decks.set(deckKey, deckTally);
        }
      }
      for (let index = 0; index < tracked.length; index += 1) for (let other = index + 1; other < tracked.length; other += 1) {
        const leftParticipant = tracked[index]!;
        const rightParticipant = tracked[other]!;
        if (leftParticipant.profileId === rightParticipant.profileId) continue;
        const sameSide = leftParticipant.side === rightParticipant.side;
        const tally = pairTally(sameSide ? coPlay : h2h, leftParticipant.profileId, rightParticipant.profileId);
        const result = tally.leftProfileId === leftParticipant.profileId ? leftParticipant.result : rightParticipant.result;
        addResult(tally, result);
      }
    }

    const byGames = <T extends TrackerTally>(left: T, right: T) => right.games - left.games;
    return {
      generatedAt: now(),
      scope: "rolling_observations",
      completenessNotice: "This is a rolling local observation history. The Clash API returns a limited recent battle-log window, so games played before tracking or between long offline periods may be absent.",
      poll: getStatus(),
      players: Array.from(playerTallies.values()).map(finalizeTally).sort(byGames),
      headToHead: Array.from(h2h.values()).map(finalizeTally).sort(byGames),
      coPlay: Array.from(coPlay.values()).map(finalizeTally).sort(byGames),
      modes: Array.from(modes.values()).map(finalizeTally).sort(byGames),
      cards: Array.from(cards.values()).map(finalizeTally).sort(byGames).slice(0, 100),
      decks: Array.from(decks.values()).map(finalizeTally).sort(byGames).slice(0, 100),
      recentGames: battles.slice(0, MAX_RECENT_BATTLES),
    };
  };

  const commandReplay = (actorProfileId: string, commandId: string, action: string, hash: string) => {
    const row = db.prepare("SELECT action,payload_hash,result_id FROM tracker_commands WHERE actor_profile_id = ? AND command_id = ?")
      .get(actorProfileId, commandId) as unknown as CommandRow | undefined;
    if (!row) return null;
    if (row.action !== action || row.payload_hash !== hash) throw new TrackerError(409, "commandId was already used for a different tracker action", "COMMAND_CONFLICT");
    return row.result_id;
  };
  const recordCommand = (actorProfileId: string, commandId: string, action: string, hash: string, resultId: string) =>
    db.prepare("INSERT INTO tracker_commands(actor_profile_id,command_id,action,payload_hash,result_id,created_at) VALUES(?,?,?,?,?,?)")
      .run(actorProfileId, commandId, action, hash, resultId, now());

  const addManualResult = (actorProfileId: string, visibleProfileIds: ReadonlySet<string>, rawInput: unknown): ManualTrackerResultResponse => {
    ensureOpen();
    if (!isRecord(rawInput)) throw new TrackerError(400, "A manual result is required", "INVALID_INPUT");
    const commandId = requireCommandId(rawInput.commandId);
    const teamAProfileIds = requireProfileIds(rawInput.teamAProfileIds, "teamAProfileIds");
    const teamBProfileIds = requireProfileIds(rawInput.teamBProfileIds, "teamBProfileIds");
    const allProfileIds = [...teamAProfileIds, ...teamBProfileIds];
    if (new Set(allProfileIds).size !== allProfileIds.length) throw new TrackerError(400, "A player can only appear once in a result", "INVALID_INPUT");
    if (allProfileIds.some((profileId) => !visibleProfileIds.has(profileId))) throw new TrackerError(403, "Manual results can only include your visible club peers", "TRACKER_FORBIDDEN");
    const playerById = new Map(getRegisteredPlayers().map((player) => [player.profileId, player]));
    if (allProfileIds.some((profileId) => !playerById.has(profileId))) throw new TrackerError(400, "Every manual participant must have a linked Clash profile", "UNLINKED_PLAYER");
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
      return { profileId, tag: player.tag, name: player.displayName, side: side as 0 | 1, crowns: crowns[side as 0 | 1], result: resultForManualSide(side as 0 | 1), elixirLeaked: null, cards: [] };
    }).sort((left, right) => left.tag.localeCompare(right.tag));
    let teams: [TrackerParticipant[], TrackerParticipant[]] = [manualTeam(teamAProfileIds, 0), manualTeam(teamBProfileIds, 1)];
    const initialSignatures = canonicalTeamSignatures(teams);
    if (initialSignatures[0]! > initialSignatures[1]!) teams = [teams[1].map((p) => ({ ...p, side: 0 })), teams[0].map((p) => ({ ...p, side: 1 }))];
    const dedupeKey = canonicalBattleKey(battleTime, type, mode.id, mode.name, teams);
    const battle: NormalizedBattle = { id: `manual_${dedupeKey.slice(0, 24)}`, dedupeKey, battleTime, type, mode, source: "manual", fetchedAt: timestamp, participants: teams.flat() };
    const action = "manual.add";
    const hash = payloadHash({ battleTime, type, mode, teamAProfileIds, teamBProfileIds, winner, crowns });
    let replayed = false;
    let resultId = battle.id;
    transaction(() => {
      const replay = commandReplay(actorProfileId, commandId, action, hash);
      if (replay) { replayed = true; resultId = replay; return; }
      resultId = insertBattle(battle, actorProfileId).id;
      recordCommand(actorProfileId, commandId, action, hash, resultId);
    });
    return { battle: readBattle(resultId), replayed };
  };

  const undoManualResult = (actorProfileId: string, visibleProfileIds: ReadonlySet<string>, rawBattleId: unknown, rawInput: unknown): UndoManualTrackerResultResponse => {
    ensureOpen();
    if (typeof rawBattleId !== "string" || !rawBattleId.trim()) throw new TrackerError(400, "battleId is required", "INVALID_INPUT");
    if (!isRecord(rawInput)) throw new TrackerError(400, "An undo command is required", "INVALID_INPUT");
    const battleId = rawBattleId.trim();
    const commandId = requireCommandId(rawInput.commandId);
    const action = `manual.undo:${battleId}`;
    const hash = payloadHash({ battleId });
    let replayed = false;
    let undone = false;
    transaction(() => {
      if (commandReplay(actorProfileId, commandId, action, hash)) { replayed = true; return; }
      const row = db.prepare(`SELECT b.source,b.created_by,p.profile_id FROM tracker_battles b
        LEFT JOIN tracker_participants p ON p.battle_id = b.id WHERE b.id = ?`).all(battleId) as unknown as { source: string; created_by: string | null; profile_id: string | null }[];
      if (row.length === 0) throw new TrackerError(404, "Tracked game was not found", "NOT_FOUND");
      if (row[0]!.source !== "manual") throw new TrackerError(409, "API games cannot be undone manually", "API_GAME_IMMUTABLE");
      if (row[0]!.created_by !== actorProfileId) throw new TrackerError(403, "Only the person who entered this result can undo it", "TRACKER_FORBIDDEN");
      if (!row.some((participant) => participant.profile_id !== null && visibleProfileIds.has(participant.profile_id))) throw new TrackerError(403, "This result is outside your visible tracker scope", "TRACKER_FORBIDDEN");
      const changed = db.prepare("UPDATE tracker_battles SET undone_at = ? WHERE id = ? AND undone_at IS NULL").run(now(), battleId);
      undone = Number(changed.changes) > 0;
      recordCommand(actorProfileId, commandId, action, hash, battleId);
    });
    return { battleId, undone, replayed };
  };

  const updatePollState = (profileId: string, values: { attemptAt: number; successAt?: number; error?: string; battlesSeen?: number }) => {
    db.prepare(`INSERT INTO tracker_poll_state(profile_id,last_attempt_at,last_success_at,last_error,battles_seen)
      VALUES(?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET
      last_attempt_at=excluded.last_attempt_at,
      last_success_at=COALESCE(excluded.last_success_at,tracker_poll_state.last_success_at),
      last_error=excluded.last_error,
      battles_seen=CASE WHEN excluded.last_success_at IS NULL THEN tracker_poll_state.battles_seen ELSE excluded.battles_seen END`)
      .run(profileId, values.attemptAt, values.successAt ?? null, values.error ?? null, values.battlesSeen ?? 0);
  };

  const fetchBattlelog = async (player: TrackerRegisteredPlayer, fetchedAt: number) => {
    const controller = new AbortController();
    activeControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(`${apiBaseUrl}/players/${encodeURIComponent(player.tag)}/battlelog`, {
        headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? Math.min(MAX_BACKOFF_MS, retryAfterSeconds * 1_000) : null;
        throw new ApiPollError(`Clash API returned ${response.status} for ${player.displayName}`, retryAfterMs);
      }
      const body = await response.text();
      if (body.length > MAX_API_BODY_BYTES) throw new ApiPollError(`Clash API response for ${player.displayName} was too large`);
      let parsed: unknown;
      try { parsed = JSON.parse(body); }
      catch { throw new ApiPollError(`Clash API returned unreadable data for ${player.displayName}`); }
      if (!Array.isArray(parsed)) throw new ApiPollError(`Clash API returned an invalid battle log for ${player.displayName}`);
      return parsed.slice(0, MAX_BATTLES_PER_RESPONSE).flatMap((battle) => {
        const normalized = normalizeApiBattle(battle, fetchedAt, getRegisteredPlayers());
        return normalized ? [normalized] : [];
      });
    } catch (error) {
      if (error instanceof ApiPollError) throw error;
      if ((error instanceof DOMException || error instanceof Error) && error.name === "AbortError") throw new ApiPollError(`Clash API timed out for ${player.displayName}`);
      throw new ApiPollError(`Clash API could not be reached for ${player.displayName}`);
    } finally {
      clearTimeout(timeout);
      activeControllers.delete(controller);
    }
  };

  const schedule = (delayMs: number) => {
    if (!autoStart || closed || !apiToken) { nextPollAt = null; return; }
    if (timer) clearTimeout(timer);
    nextPollAt = now() + delayMs;
    timer = setTimeout(() => { timer = null; void syncNow(); }, delayMs);
    timer.unref?.();
  };

  const syncNow = async (): Promise<TrackerPollStatus> => {
    ensureOpen();
    if (!apiToken || polling) return getStatus();
    polling = true;
    nextPollAt = null;
    const attemptAt = now();
    lastPollAt = attemptAt;
    let failures = 0;
    let retryAfterMs = 0;
    for (const player of getRegisteredPlayers()) {
      if (closed) break;
      try {
        const battles = await fetchBattlelog(player, attemptAt);
        transaction(() => {
          for (const battle of battles) insertBattle(battle, null);
          updatePollState(player.profileId, { attemptAt, successAt: now(), battlesSeen: battles.length });
        });
      } catch (error) {
        if (closed) break;
        failures += 1;
        const failure = error instanceof ApiPollError ? error : new ApiPollError("Clash API polling failed");
        retryAfterMs = Math.max(retryAfterMs, failure.retryAfterMs ?? 0);
        updatePollState(player.profileId, { attemptAt, error: failure.message });
      }
    }
    polling = false;
    if (closed) return getStatus();
    consecutiveFailures = failures > 0 ? Math.min(consecutiveFailures + 1, 8) : 0;
    const exponentialDelay = Math.min(MAX_BACKOFF_MS, pollIntervalMs * 2 ** consecutiveFailures);
    schedule(Math.max(retryAfterMs, failures > 0 ? exponentialDelay : pollIntervalMs));
    return getStatus();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    nextPollAt = null;
    for (const controller of activeControllers) controller.abort();
    activeControllers.clear();
    db.close();
  };

  if (autoStart && apiToken) schedule(2_000);

  return { getRegisteredPlayers, getStatus, getSummary, syncNow, addManualResult, undoManualResult, close };
};
