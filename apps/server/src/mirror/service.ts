import { createHash, randomBytes as cryptoRandomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  ArenaCard,
  DeckDefinition,
  MirrorPlaylistKey,
  MirrorPlaylistSummary,
  MirrorRoomCommand,
  MirrorRoomCredential,
  MirrorRoomSeat,
  MirrorRoomSessionResponse,
  MirrorRoomView,
} from "@draft-royale/shared";
import { DeckError, validateLibraryDeck } from "../decks/service.js";

const playlistKeys: MirrorPlaylistKey[] = ["mirror", "classics", "community"];
const playlistLabels: Record<MirrorPlaylistKey, string> = {
  mirror: "Mirror remixes",
  classics: "Classic decks",
  community: "Community decks",
};
const playlistDescriptions: Record<MirrorPlaylistKey, string> = {
  mirror: "Generated Mirror remixes from legal library decks; these are not Supercell's official Mirror pool.",
  classics: "Familiar historical decks, unchanged for identical-deck battles.",
  community: "Public decks shared by players.",
};
const maxPlaylistCandidates = 500;

interface MirrorHistoryEntry {
  playlist: MirrorPlaylistKey;
  candidateId: string | null;
  candidateIndex: number;
  deck: DeckDefinition;
}

interface MirrorRoomState {
  schema: 1;
  id: string;
  code: string;
  revision: number;
  hostName: string;
  guestName: string | null;
  playlist: MirrorPlaylistKey;
  history: MirrorHistoryEntry[];
  historyIndex: number;
  seenCandidateIds: Record<MirrorPlaylistKey, string[]>;
  createdAt: number;
  updatedAt: number;
}

interface Candidate {
  id: string;
  deck: DeckDefinition;
}

interface RoomRow { state_json: string }
interface SeatRow { seat: MirrorRoomSeat }
interface CommandRow { payload_hash: string; result_json: string }

export class MirrorRoomError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) {
    super(message);
  }
}

export interface MirrorRoomServiceOptions {
  databasePath: string;
  catalog: readonly ArenaCard[];
  getDecks: () => readonly DeckDefinition[];
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

export interface MirrorRoomService {
  create(input: { name: unknown; playlist?: unknown; deck?: unknown }): MirrorRoomSessionResponse;
  join(input: { code: unknown; name: unknown }): MirrorRoomSessionResponse;
  get(roomId: string, token: string): MirrorRoomView;
  command(roomId: string, token: string, input: unknown): MirrorRoomView;
  close(): void;
}

const clone = <T>(value: T): T => structuredClone(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const payloadHash = (value: unknown) => hash(JSON.stringify(value));
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MirrorRoomError(400, "A JSON object is required.", "INVALID_BODY");
  return value as Record<string, unknown>;
};
const text = (value: unknown, label: string, max: number) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new MirrorRoomError(400, `${label} must contain 1–${max} characters.`, "INVALID_INPUT");
  return value.trim();
};
const playlistFrom = (value: unknown, fallback?: MirrorPlaylistKey): MirrorPlaylistKey => {
  const candidate = value ?? fallback;
  if (!playlistKeys.includes(candidate as MirrorPlaylistKey)) throw new MirrorRoomError(400, "Choose mirror, classics, or community.", "INVALID_PLAYLIST");
  return candidate as MirrorPlaylistKey;
};
const normalizeCode = (value: unknown) => text(value, "Invite code", 16).replace(/[\s-]/g, "").toUpperCase();

const sourceDeckId = (deck: DeckDefinition) => deck.id || hash(JSON.stringify({ cards: [...deck.cards].sort(), forms: deck.forms ?? {}, name: deck.name })).slice(0, 16);
const deckSignature = (deck: DeckDefinition) => JSON.stringify([...deck.cards].sort().map((key) => [key, deck.forms?.[key] ?? "base"]));

const validatedSourceDeck = (deck: DeckDefinition, catalog: readonly ArenaCard[], mode = deck.mode): DeckDefinition | null => {
  try {
    const valid = validateLibraryDeck({ ...deck, mode }, catalog);
    return { ...valid, id: deck.id, source: clone(deck.source), ...(deck.visibility ? { visibility: deck.visibility } : {}), ...(deck.ownerId ? { ownerId: deck.ownerId } : {}), ...(deck.author ? { author: deck.author } : {}), ...(deck.updatedAt ? { updatedAt: deck.updatedAt } : {}) };
  } catch (error) {
    if (error instanceof DeckError) return null;
    throw error;
  }
};

const uniqueCandidates = (candidates: Candidate[]) => {
  const signatures = new Set<string>();
  return candidates.filter((candidate) => {
    const signature = deckSignature(candidate.deck);
    if (signatures.has(signature)) return false;
    signatures.add(signature);
    return true;
  }).slice(0, maxPlaylistCandidates);
};

/** Deterministic, provenance-preserving variants. They are explicitly not represented as Supercell's official Mirror pool. */
export const buildMirrorRemixCandidates = (decks: readonly DeckDefinition[], catalog: readonly ArenaCard[]): Candidate[] => {
  const cardsByKey = new Map(catalog.map((card) => [card.key, card]));
  const candidates: Candidate[] = [];
  for (const sourceDeck of decks) {
    if (candidates.length >= maxPlaylistCandidates) break;
    if (sourceDeck.mode === "chaos") continue;
    const source = validatedSourceDeck(sourceDeck, catalog);
    if (!source) continue;
    const stableSourceId = sourceDeckId(source);
    if (source.cards.includes("mirror")) {
      const valid = validatedSourceDeck({ ...source, mode: "mirror" }, catalog, "mirror");
      if (valid) candidates.push({ id: `mirror:${stableSourceId}:original`, deck: valid });
      continue;
    }
    for (let index = 0; index < source.cards.length && candidates.length < maxPlaylistCandidates; index += 1) {
      const replacedKey = source.cards[index] as string;
      const cards = source.cards.map((key, cardIndex) => cardIndex === index ? "mirror" : key);
      if (new Set(cards).size !== 8) continue;
      const forms = { ...(source.forms ?? {}) };
      delete forms[replacedKey];
      forms.mirror = "base";
      const replacementName = cardsByKey.get(replacedKey)?.name ?? replacedKey;
      const generated: DeckDefinition = {
        ...source,
        id: `mirror-remix-${stableSourceId}-${replacedKey}`.slice(0, 100),
        name: `${source.name} · Mirror for ${replacementName}`.slice(0, 80),
        mode: "mirror",
        cards,
        forms,
        description: `Generated from ${source.name} by replacing ${replacementName} with Mirror. This is a community remix, not an official Clash Royale Mirror-pool deck.`,
        tags: Array.from(new Set([...(source.tags ?? []), "generated-mirror", "not-official-pool"])).slice(0, 10),
        source: {
          ...source.source,
          kind: "local",
          label: `Generated Mirror remix · not official · ${source.source.label}`,
          sourceId: source.id || source.source.sourceId,
        },
      };
      const valid = validatedSourceDeck(generated, catalog, "mirror");
      if (valid) candidates.push({ id: `mirror:${stableSourceId}:${replacedKey}`, deck: valid });
    }
  }
  return uniqueCandidates(candidates);
};

const buildCandidates = (playlist: MirrorPlaylistKey, decks: readonly DeckDefinition[], catalog: readonly ArenaCard[]): Candidate[] => {
  if (playlist === "mirror") return buildMirrorRemixCandidates(decks, catalog);
  const matching = decks.filter((deck) => playlist === "classics"
    ? deck.mode === "classic" && deck.source.kind !== "community"
    : deck.source.kind === "community" || Boolean(deck.ownerId || deck.author));
  return uniqueCandidates(matching.flatMap((deck) => {
    const valid = validatedSourceDeck(deck, catalog);
    return valid ? [{ id: `${playlist}:${sourceDeckId(valid)}`, deck: valid }] : [];
  }));
};

export const createMirrorRoomService = (options: MirrorRoomServiceOptions): MirrorRoomService => {
  const db = new DatabaseSync(options.databasePath);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS mirror_rooms (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mirror_credentials (
      room_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      seat TEXT NOT NULL CHECK(seat IN ('a','b')),
      PRIMARY KEY(room_id, token_hash),
      UNIQUE(room_id, seat),
      FOREIGN KEY(room_id) REFERENCES mirror_rooms(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS mirror_commands (
      room_id TEXT NOT NULL,
      seat TEXT NOT NULL CHECK(seat IN ('a','b')),
      command_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      PRIMARY KEY(room_id, seat, command_id),
      FOREIGN KEY(room_id) REFERENCES mirror_rooms(id) ON DELETE CASCADE
    );
  `);
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? cryptoRandomBytes;
  const candidateCache = new Map<MirrorPlaylistKey, { source: readonly DeckDefinition[]; candidates: Candidate[] }>();

  const candidatesFor = (playlist: MirrorPlaylistKey, source = options.getDecks()) => {
    const cached = candidateCache.get(playlist);
    if (cached?.source === source) return cached.candidates;
    const candidates = buildCandidates(playlist, source, options.catalog);
    candidateCache.set(playlist, { source, candidates });
    return candidates;
  };
  const playlistSummaries = (): MirrorPlaylistSummary[] => {
    const source = options.getDecks();
    return playlistKeys.map((id) => ({ id, label: playlistLabels[id], description: playlistDescriptions[id], count: candidatesFor(id, source).length }));
  };
  const makeToken = () => Buffer.from(randomBytes(32)).toString("base64url");
  const makeCode = () => Buffer.from(randomBytes(6)).toString("base64url").replace(/[-_]/g, "").slice(0, 8).toUpperCase();
  const allocateCode = () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const code = makeCode();
      if (code.length >= 6 && !db.prepare("SELECT 1 AS found FROM mirror_rooms WHERE code=?").get(code)) return code;
    }
    throw new MirrorRoomError(503, "Could not create an invite code.", "INVITE_UNAVAILABLE");
  };
  const decodeRoom = (json: string): MirrorRoomState => {
    try {
      const room = JSON.parse(json) as MirrorRoomState;
      if (room.schema !== 1 || typeof room.id !== "string" || !Array.isArray(room.history) || !room.history[room.historyIndex]) throw new Error("invalid room");
      return room;
    } catch {
      throw new MirrorRoomError(500, "Stored Mirror room state is invalid.", "INVALID_ROOM_STATE");
    }
  };
  const loadRoom = (roomId: string) => {
    const row = db.prepare("SELECT state_json FROM mirror_rooms WHERE id=?").get(roomId) as unknown as RoomRow | undefined;
    if (!row) throw new MirrorRoomError(404, "Mirror room not found.", "ROOM_NOT_FOUND");
    return decodeRoom(row.state_json);
  };
  const saveRoom = (room: MirrorRoomState) => db.prepare("UPDATE mirror_rooms SET state_json=?,updated_at=? WHERE id=?").run(JSON.stringify(room), room.updatedAt, room.id);
  const seatFor = (roomId: string, token: string): MirrorRoomSeat => {
    if (!token || token.length > 256) throw new MirrorRoomError(401, "Bearer room credentials are required.", "UNAUTHORIZED");
    const row = db.prepare("SELECT seat FROM mirror_credentials WHERE room_id=? AND token_hash=?").get(roomId, hash(token)) as unknown as SeatRow | undefined;
    if (!row) throw new MirrorRoomError(401, "Valid room credentials are required.", "UNAUTHORIZED");
    return row.seat;
  };
  const viewFor = (room: MirrorRoomState, viewer: MirrorRoomSeat): MirrorRoomView => {
    const entry = room.history[room.historyIndex] as MirrorHistoryEntry;
    const summaries = playlistSummaries();
    return {
      id: room.id,
      code: room.code,
      revision: room.revision,
      viewer,
      hostName: room.hostName,
      guestName: room.guestName,
      playlist: entry.playlist,
      availablePlaylists: summaries,
      deck: clone(entry.deck),
      index: entry.candidateIndex,
      playlistCount: summaries.find((summary) => summary.id === entry.playlist)?.count ?? 0,
      historyIndex: room.historyIndex,
      historyCount: room.history.length,
      canGoPrevious: room.historyIndex > 0,
      canGoForward: room.historyIndex < room.history.length - 1,
      canEdit: viewer === "a",
      updatedAt: room.updatedAt,
      serverNow: now(),
    };
  };
  const chooseCandidate = (room: Pick<MirrorRoomState, "seenCandidateIds" | "history" | "historyIndex">, playlist: MirrorPlaylistKey, random: boolean) => {
    const candidates = candidatesFor(playlist);
    if (!candidates.length) throw new MirrorRoomError(409, `${playlistLabels[playlist]} has no legal decks yet.`, "PLAYLIST_EMPTY");
    let seen = new Set(room.seenCandidateIds[playlist] ?? []);
    let remaining = candidates.filter((candidate) => !seen.has(candidate.id));
    if (!remaining.length) {
      const currentId = room.history[room.historyIndex]?.candidateId;
      seen = new Set(currentId ? [currentId] : []);
      remaining = candidates.filter((candidate) => !seen.has(candidate.id));
      if (!remaining.length) remaining = [...candidates];
    }
    let candidate: Candidate;
    if (random) {
      const bytes = randomBytes(4);
      const randomValue = ((bytes[0] ?? 0) * 0x1000000 + (bytes[1] ?? 0) * 0x10000 + (bytes[2] ?? 0) * 0x100 + (bytes[3] ?? 0)) >>> 0;
      candidate = remaining[randomValue % remaining.length] as Candidate;
    } else {
      const currentIndex = room.history[room.historyIndex]?.playlist === playlist ? room.history[room.historyIndex]?.candidateIndex ?? -1 : -1;
      candidate = [...remaining].sort((left, right) => {
        const leftIndex = candidates.indexOf(left);
        const rightIndex = candidates.indexOf(right);
        const leftDistance = (leftIndex - currentIndex + candidates.length) % candidates.length || candidates.length;
        const rightDistance = (rightIndex - currentIndex + candidates.length) % candidates.length || candidates.length;
        return leftDistance - rightDistance;
      })[0] as Candidate;
    }
    seen.add(candidate.id);
    room.seenCandidateIds[playlist] = [...seen];
    return { playlist, candidateId: candidate.id, candidateIndex: candidates.indexOf(candidate), deck: clone(candidate.deck) } satisfies MirrorHistoryEntry;
  };
  const validateCustom = (input: unknown, playlist: MirrorPlaylistKey, source?: DeckDefinition["source"]): DeckDefinition => {
    const body = record(input);
    try {
      const valid = validateLibraryDeck({ ...body, mode: playlist === "mirror" ? "mirror" : "custom" }, options.catalog);
      const sourceLabel = source?.label.replace(/^Custom remix of /, "");
      const submittedId = typeof body.id === "string" && body.id.trim() ? body.id.trim().slice(0, 100) : null;
      const id = source
        ? source.kind === "local" && submittedId?.startsWith("mirror-room-deck-") ? submittedId : `mirror-room-deck-${randomUUID()}`
        : submittedId ?? `mirror-room-deck-${randomUUID()}`;
      return {
        ...valid,
        id,
        source: source
          ? { kind: "local", label: `Custom remix of ${sourceLabel}`.slice(0, 160), ...(source.sourceId ? { sourceId: source.sourceId } : {}) }
          : { kind: "local", label: "Custom synchronized room deck" },
      };
    } catch (error) {
      if (error instanceof DeckError) throw new MirrorRoomError(error.status, error.message, "INVALID_DECK");
      throw error;
    }
  };

  const create = (input: { name: unknown; playlist?: unknown; deck?: unknown }): MirrorRoomSessionResponse => {
    const hostName = text(input.name, "Name", 32);
    const playlist = playlistFrom(input.playlist, "mirror");
    const timestamp = now();
    const provisional = {
      seenCandidateIds: { mirror: [], classics: [], community: [] },
      history: [] as MirrorHistoryEntry[],
      historyIndex: 0,
    };
    const entry = input.deck === undefined
      ? chooseCandidate(provisional, playlist, false)
      : { playlist, candidateId: null, candidateIndex: -1, deck: validateCustom(input.deck, playlist) };
    const room: MirrorRoomState = {
      schema: 1,
      id: randomUUID(),
      code: allocateCode(),
      revision: 1,
      hostName,
      guestName: null,
      playlist,
      history: [entry],
      historyIndex: 0,
      seenCandidateIds: provisional.seenCandidateIds,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const token = makeToken();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO mirror_rooms VALUES(?,?,?,?)").run(room.id, room.code, JSON.stringify(room), timestamp);
      db.prepare("INSERT INTO mirror_credentials VALUES(?,?,?)").run(room.id, hash(token), "a");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const credential: MirrorRoomCredential = { roomId: room.id, seat: "a", token };
    return { credential, room: viewFor(room, "a") };
  };

  const join = (input: { code: unknown; name: unknown }): MirrorRoomSessionResponse => {
    const code = normalizeCode(input.code);
    const guestName = text(input.name, "Name", 32);
    const token = makeToken();
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare("SELECT state_json FROM mirror_rooms WHERE code=?").get(code) as unknown as RoomRow | undefined;
      if (!row) throw new MirrorRoomError(404, "Mirror room not found.", "ROOM_NOT_FOUND");
      const room = decodeRoom(row.state_json);
      if (room.guestName !== null) throw new MirrorRoomError(409, "This Mirror room already has two players.", "ROOM_FULL");
      room.guestName = guestName;
      room.revision += 1;
      room.updatedAt = now();
      saveRoom(room);
      db.prepare("INSERT INTO mirror_credentials VALUES(?,?,?)").run(room.id, hash(token), "b");
      db.exec("COMMIT");
      const credential: MirrorRoomCredential = { roomId: room.id, seat: "b", token };
      return { credential, room: viewFor(room, "b") };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const get = (roomId: string, token: string) => {
    const seat = seatFor(roomId, token);
    return viewFor(loadRoom(roomId), seat);
  };

  const command = (roomId: string, token: string, input: unknown): MirrorRoomView => {
    const seat = seatFor(roomId, token);
    const value = record(input);
    const action = value.action;
    if (!["next", "previous", "shuffle", "edit", "playlist"].includes(String(action))) throw new MirrorRoomError(400, "Choose a valid Mirror-room action.", "INVALID_ACTION");
    const expectedRevision = value.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) throw new MirrorRoomError(400, "expectedRevision must be a positive integer.", "INVALID_REVISION");
    const commandId = text(value.commandId, "commandId", 100);
    const normalized: MirrorRoomCommand = action === "edit"
      ? { action, expectedRevision: expectedRevision as number, commandId, deck: value.deck as DeckDefinition }
      : action === "playlist"
        ? { action, expectedRevision: expectedRevision as number, commandId, playlist: playlistFrom(value.playlist) }
        : { action: action as "next" | "previous" | "shuffle", expectedRevision: expectedRevision as number, commandId };
    const requestHash = payloadHash(normalized);
    db.exec("BEGIN IMMEDIATE");
    try {
      const previous = db.prepare("SELECT payload_hash,result_json FROM mirror_commands WHERE room_id=? AND seat=? AND command_id=?").get(roomId, seat, commandId) as unknown as CommandRow | undefined;
      if (previous) {
        if (previous.payload_hash !== requestHash) throw new MirrorRoomError(409, "commandId was already used for another action.", "COMMAND_ID_REUSED");
        db.exec("COMMIT");
        return JSON.parse(previous.result_json) as MirrorRoomView;
      }
      if (seat !== "a") throw new MirrorRoomError(403, "Only the host can change the synchronized deck.", "FORBIDDEN");
      const room = loadRoom(roomId);
      if (room.revision !== normalized.expectedRevision) throw new MirrorRoomError(409, "The room changed. Refresh before choosing another deck.", "REVISION_CONFLICT");
      if (normalized.action === "previous") {
        if (room.historyIndex === 0) throw new MirrorRoomError(409, "This is the first deck in room history.", "HISTORY_START");
        room.historyIndex -= 1;
        room.playlist = (room.history[room.historyIndex] as MirrorHistoryEntry).playlist;
      } else if (normalized.action === "next" && room.historyIndex < room.history.length - 1) {
        room.historyIndex += 1;
        room.playlist = (room.history[room.historyIndex] as MirrorHistoryEntry).playlist;
      } else if (normalized.action === "edit") {
        const current = room.history[room.historyIndex] as MirrorHistoryEntry;
        current.deck = validateCustom(normalized.deck, current.playlist, current.deck.source);
        current.candidateId = null;
        current.candidateIndex = -1;
      } else {
        const playlist = normalized.action === "playlist" ? normalized.playlist : room.playlist;
        room.history = room.history.slice(0, room.historyIndex + 1);
        room.history.push(chooseCandidate(room, playlist, normalized.action === "shuffle"));
        room.historyIndex = room.history.length - 1;
        room.playlist = playlist;
      }
      room.revision += 1;
      room.updatedAt = now();
      saveRoom(room);
      const result = viewFor(room, seat);
      db.prepare("INSERT INTO mirror_commands VALUES(?,?,?,?,?)").run(roomId, seat, commandId, requestHash, JSON.stringify(result));
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  return { create, join, get, command, close: () => db.close() };
};
