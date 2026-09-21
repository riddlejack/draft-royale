import { createHash, randomBytes as cryptoRandomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildClashRoyaleDeckLink,
  DEFAULT_ARENA_SETTINGS,
  effectiveMegaPoolSize,
  filterArenaCards,
  isFixedArenaElixirCost,
  isChaosInfiniteElixirBattleMode,
  isChaosInfiniteElixirSupportedCard,
  ARENA_MEGA_MAX_POOL_SIZE,
  ARENA_MEGA_MIN_POOL_SIZE,
  ARENA_MIRROR_CARD_KEY,
  ARENA_MIRROR_PICK_COUNT,
  shouldPresetMirrorCard,
  isArenaElixirRanges,
  type ArenaCard,
  type ArenaCatalogResponse,
  type ArenaCell,
  type ArenaCollection,
  type ArenaEntry,
  type ArenaForm,
  type ArenaMode,
  type ArenaPickEvent,
  type ArenaRoundKind,
  type ArenaSeat,
  type ArenaSessionResponse,
  type ArenaSettings,
  type ArenaView,
} from "@draft-royale/shared";

const seats = ["a", "b"] as const;
const forms = ["base", "evolution", "hero", "champion"] as const;
const deckSize = 8;
/** Canonical Mega sequence. `megaPickOrderFor` maps A/B onto the stored starter. */
const megaPickOrder: ArenaSeat[] = ["a", "b", "b", "a", "a", "b", "b", "a", "a", "b", "b", "a", "a", "b", "b", "a"];
const mirrorPickOrder: ArenaSeat[] = ["a", "b", "a", "b", "a", "b", "a", "b"];
const groupedTripleSchedule: ArenaRoundKind[] = ["evolution", "evolution", "hero_champion", "base", "base", "base", "base", "base"];
const presetMirrorGroupedSchedule: ArenaRoundKind[] = ["evolution", "evolution", "hero_champion", "base", "base", "base", "base"];

interface InternalParticipant {
  seat: ArenaSeat;
  name: string;
  ready: boolean;
  loaded: boolean;
  bot: boolean;
  collection: ArenaCollection;
}

interface InternalRoom {
  schema: 2;
  id: string;
  inviteCode: string;
  catalogVersion: string;
  catalogUpdatedAt: string;
  catalogCards: ArenaCard[];
  seed: string;
  round: number;
  revision: number;
  phase: ArenaView["phase"];
  settings: ArenaSettings;
  practice: boolean;
  participants: Partial<Record<ArenaSeat, InternalParticipant>>;
  decks: Record<ArenaSeat, ArenaEntry[]>;
  boardKeys: string[];
  selected: Record<string, { seat: ArenaSeat; form: ArenaForm }>;
  remainingPool: string[];
  currentOffers: Record<ArenaSeat, string[]>;
  offerQueues: Record<ArenaSeat, string[][]>;
  sharedOfferQueue: string[][];
  offerRevision: Record<ArenaSeat, number>;
  /** First picker for this Mega round. It is never inferred from host status. */
  megaStarter: ArenaSeat | null;
  /** Opaque stable social-pair hash; absent for anonymous invite-code rooms. */
  megaPairKey?: string;
  activeSeat: ArenaSeat | null;
  pickNumber: number;
  totalPicks: number;
  startedAt: number | null;
  interactiveAt: number | null;
  deadlineAt: number | null;
  interactiveAtBySeat: Record<ArenaSeat, number | null>;
  deadlineAtBySeat: Record<ArenaSeat, number | null>;
  wholeDraftDeadlineAt: number | null;
  loadDeadlineAt: number | null;
  events: ArenaPickEvent[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface CredentialRow {
  room_id: string;
  seat: ArenaSeat;
}

interface RoomRow {
  state_json: string;
}

interface CommandRow {
  payload_hash: string;
}

interface InvitedOperationRow {
  payload_hash: string;
  room_id: string;
}

interface MegaPairRow {
  next_starter: ArenaSeat;
}

export interface ArenaServiceOptions {
  catalog: ArenaCard[];
  catalogVersion: string;
  catalogUpdatedAt?: string;
  databasePath?: string;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  roomTtlMs?: number;
  /** Overrides the initial board/offer reveal delay for every mode. */
  initialDealMs?: number;
  presentationDelayMs?: number;
  botDelayMs?: number;
  loadingTimeoutMs?: number;
}

export interface CreateRoomInput {
  name: unknown;
  settings?: unknown;
  practice?: unknown;
  collection?: unknown;
}

export interface JoinRoomInput {
  inviteCode: unknown;
  name: unknown;
  collection?: unknown;
}

export interface InvitedRoomParticipantInput {
  name: string;
  collection: ArenaCollection;
  /** SHA-256 of the participant's independently derived opaque room token. */
  tokenHash: string;
}

export interface CreateInvitedRoomInput {
  operationId: string;
  settings: ArenaSettings;
  host: InvitedRoomParticipantInput;
  guest: InvitedRoomParticipantInput;
  /** Optional opaque, stable social-pair key. Never use a display name or player tag. */
  pairKey?: string;
}

export interface CreateInvitedRoomResult {
  roomId: string;
  hostRoom: ArenaView;
  guestRoom: ArenaView;
}

export interface ArenaService {
  readonly catalog: { version: string; updatedAt: string; cards: ArenaCard[] };
  normalizeSettings(input: unknown): ArenaSettings;
  normalizeCollection(input: unknown): ArenaCollection;
  createInvitedRoom(input: CreateInvitedRoomInput): CreateInvitedRoomResult;
  rebindInvitedSeat(roomId: string, seat: ArenaSeat, tokenHash: string): void;
  createRoom(input: CreateRoomInput): ArenaSessionResponse;
  joinRoom(input: JoinRoomInput): ArenaSessionResponse;
  getRoomCatalog(roomId: string, token: string): ArenaCatalogResponse;
  getView(roomId: string, token: string): ArenaView;
  setReady(roomId: string, token: string, input: { ready: unknown; commandId: unknown }): ArenaView;
  setLoaded(roomId: string, token: string, input: { commandId: unknown }): ArenaView;
  pick(roomId: string, token: string, input: { cardKey: unknown; form: unknown; commandId: unknown; expectedRevision: unknown }): ArenaView;
  setCollection(roomId: string, token: string, input: { collection: unknown; commandId: unknown }): ArenaView;
  setSettings(roomId: string, token: string, input: { settings: unknown; commandId: unknown }): ArenaView;
  rematch(roomId: string, token: string, input: { commandId: unknown }): ArenaView;
  subscribe(roomId: string, token: string, send: (view: ArenaView) => void, close: () => void): () => void;
  close(): void;
}

export class ArenaError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

const asRecord = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ArenaError(400, "A JSON object is required", "INVALID_BODY");
  return input as Record<string, unknown>;
};

const requireString = (value: unknown, label: string, max: number) => {
  if (typeof value !== "string") throw new ArenaError(400, `${label} is required`, "INVALID_INPUT");
  const result = value.trim();
  if (!result || result.length > max) throw new ArenaError(400, `${label} must be 1-${max} characters`, "INVALID_INPUT");
  return result;
};

const requireCommandId = (value: unknown) => requireString(value, "commandId", 100);

const normalizeCode = (value: unknown) => requireString(value, "inviteCode", 16).replace(/[\s-]/g, "").toUpperCase();

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const payloadHash = (value: unknown) => sha256(JSON.stringify(value));

const otherSeat = (seat: ArenaSeat): ArenaSeat => (seat === "a" ? "b" : "a");

const clone = <T>(value: T): T => structuredClone(value);

const decodeRoom = (json: string): InternalRoom => {
  try {
    const room = JSON.parse(json) as InternalRoom;
    if (
      room.schema !== 2 ||
      typeof room.id !== "string" ||
      typeof room.revision !== "number" ||
      !["waiting", "loading", "drafting", "complete"].includes(room.phase) ||
      !Array.isArray(room.catalogCards) ||
      !Array.isArray(room.events)
    ) {
      throw new Error("invalid room shape");
    }
    // Schema 2 predates whole-draft timers. Preserve those active rooms with
    // their original per-pick behavior instead of silently changing clocks.
    if (room.catalogUpdatedAt === undefined) room.catalogUpdatedAt = new Date(room.createdAt).toISOString();
    if (room.settings.timerMode === undefined) room.settings.timerMode = "per_pick";
    if (room.settings.mirrorMode === undefined) room.settings.mirrorMode = false;
    if (room.sharedOfferQueue === undefined) room.sharedOfferQueue = [];
    if (room.wholeDraftDeadlineAt === undefined) room.wholeDraftDeadlineAt = null;
    // Before starter persistence, all active Mega rooms used seat A. Preserve
    // their existing sequence; waiting/loading rooms have not consumed a start.
    if (room.megaStarter !== "a" && room.megaStarter !== "b") {
      room.megaStarter = room.settings.mode === "mega" && !room.settings.mirrorMode
        && (room.phase === "drafting" || room.phase === "complete") ? "a" : null;
    }
    return room;
  } catch {
    throw new ArenaError(500, "Stored room state is invalid", "INVALID_ROOM_STATE");
  }
};

const defaultCollection = (): ArenaCollection => ({ cards: null, forms: null, source: "unrestricted" });

const sanitizeCollection = (input: unknown, catalogKeys: ReadonlySet<string>): ArenaCollection => {
  if (input === undefined || input === null) return defaultCollection();
  const value = asRecord(input);
  let cards: string[] | null = null;
  if (value.cards !== undefined && value.cards !== null) {
    if (!Array.isArray(value.cards) || value.cards.length > catalogKeys.size) {
      throw new ArenaError(400, "collection.cards must be null or a bounded card key list", "INVALID_COLLECTION");
    }
    cards = Array.from(new Set(value.cards.map((key) => requireString(key, "collection card key", 100))));
    if (cards.some((key) => !catalogKeys.has(key))) throw new ArenaError(400, "Collection contains an unknown card", "INVALID_COLLECTION");
  }

  let ownedForms: Record<string, ArenaForm[]> | null = null;
  if (value.forms !== undefined && value.forms !== null) {
    const formRecord = asRecord(value.forms);
    if (Object.keys(formRecord).length > catalogKeys.size) throw new ArenaError(400, "collection.forms is too large", "INVALID_COLLECTION");
    ownedForms = {};
    for (const [cardKey, rawForms] of Object.entries(formRecord)) {
      if (!catalogKeys.has(cardKey) || !Array.isArray(rawForms)) throw new ArenaError(400, "Collection contains invalid form ownership", "INVALID_COLLECTION");
      const normalized = Array.from(new Set(rawForms.map((form) => requireString(form, "form", 20)))) as ArenaForm[];
      if (normalized.some((form) => !forms.includes(form))) throw new ArenaError(400, "Collection contains an unknown form", "INVALID_COLLECTION");
      ownedForms[cardKey] = normalized;
    }
  }

  const unrestricted = cards === null && ownedForms === null;
  if (unrestricted) return defaultCollection();
  if (value.source === "api" && value.profile !== undefined) {
    const profile = asRecord(value.profile);
    const tag = requireString(profile.tag, "collection profile tag", 20).toUpperCase();
    const name = requireString(profile.name, "collection profile name", 80);
    const fetchedAt = requireString(profile.fetchedAt, "collection profile fetchedAt", 40);
    if (!/^#[0289PYLQGRJCUV]{3,15}$/.test(tag) || !Number.isFinite(Date.parse(fetchedAt))) {
      throw new ArenaError(400, "Collection contains invalid API profile metadata", "INVALID_COLLECTION");
    }
    return { cards, forms: ownedForms, source: "api", profile: { tag, name, fetchedAt: new Date(fetchedAt).toISOString() } };
  }
  return { cards, forms: ownedForms, source: "manual" };
};

const stringList = (value: unknown, label: string, knownValues: ReadonlySet<string>) => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > knownValues.size) throw new ArenaError(400, `${label} must be a bounded string list`, "INVALID_SETTINGS");
  const result = Array.from(new Set(value.map((item) => requireString(item, label, 100))));
  if (result.some((item) => !knownValues.has(item))) throw new ArenaError(400, `${label} contains an unknown value`, "INVALID_SETTINGS");
  return result;
};

const cardIdList = (value: unknown, label: string, knownValues: ReadonlySet<number>) => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > knownValues.size) throw new ArenaError(400, `${label} must be a bounded card id list`, "INVALID_SETTINGS");
  if (value.some((item) => !Number.isSafeInteger(item) || (item as number) <= 0)) {
    throw new ArenaError(400, `${label} must contain positive integer card ids`, "INVALID_SETTINGS");
  }
  const result = Array.from(new Set(value as number[]));
  if (result.some((item) => !knownValues.has(item))) throw new ArenaError(400, `${label} contains an unknown card id`, "INVALID_SETTINGS");
  return result;
};

const optionalSetting = (value: Record<string, unknown>, key: string, base: unknown) =>
  value[key] === null ? undefined : value[key] === undefined ? base : value[key];

const sanitizeSettings = (input: unknown, base: ArenaSettings, catalog: readonly ArenaCard[]): ArenaSettings => {
  const value = input === undefined ? {} : asRecord(input);
  const catalogKeys = new Set(catalog.map((card) => card.key));
  const catalogIds = new Set(catalog.map((card) => card.id));
  const catalogKinds = new Set(catalog.map((card) => card.kind));
  const catalogRarities = new Set(catalog.map((card) => card.rarity));
  const catalogFamilies = new Set(catalog.flatMap((card) => card.families));
  const mode = value.mode ?? base.mode;
  if (mode !== "mega" && mode !== "triple" && mode !== "classic") throw new ArenaError(400, "Unknown arena mode", "INVALID_SETTINGS");
  const modeChanged = value.mode !== undefined && mode !== base.mode;
  const nativeTimerMode = mode === "mega" ? "per_pick" : "whole_draft";
  const timerMode = value.timerMode ?? (modeChanged ? nativeTimerMode : base.timerMode ?? nativeTimerMode);
  if (timerMode !== "per_pick" && timerMode !== "whole_draft") throw new ArenaError(400, "Unknown timer mode", "INVALID_SETTINGS");
  const rawPoolSize = value.poolSize ?? base.poolSize;
  if (!Number.isInteger(rawPoolSize) || (rawPoolSize as number) < ARENA_MEGA_MIN_POOL_SIZE || (rawPoolSize as number) > 96) {
    throw new ArenaError(400, "poolSize must be an integer from 16 to 96", "INVALID_SETTINGS");
  }
  const poolSize = Math.min(rawPoolSize as number, ARENA_MEGA_MAX_POOL_SIZE);
  const rawPickSeconds = value.pickSeconds ?? (modeChanged ? (mode === "mega" ? 15 : 60) : base.pickSeconds);
  if (!Number.isInteger(rawPickSeconds) || (rawPickSeconds as number) < 1 || (rawPickSeconds as number) > 120) {
    throw new ArenaError(400, "pickSeconds must be an integer from 1 to 120", "INVALID_SETTINGS");
  }
  const requestedSpecialForms = value.specialForms ?? base.specialForms;
  if (typeof requestedSpecialForms !== "boolean") throw new ArenaError(400, "specialForms must be boolean", "INVALID_SETTINGS");
  const requestedGrouping = value.groupedSpecialRounds ?? (modeChanged ? false : base.groupedSpecialRounds ?? false);
  if (typeof requestedGrouping !== "boolean") throw new ArenaError(400, "groupedSpecialRounds must be boolean", "INVALID_SETTINGS");
  const mirrorMode = value.mirrorMode ?? base.mirrorMode ?? false;
  if (typeof mirrorMode !== "boolean") throw new ArenaError(400, "mirrorMode must be boolean", "INVALID_SETTINGS");
  const battleMode = requireString(value.battleMode ?? base.battleMode, "battleMode", 80);
  const specialForms = isChaosInfiniteElixirBattleMode(battleMode) ? false : requestedSpecialForms;
  const groupedSpecialRounds = mode === "triple" && specialForms ? requestedGrouping : false;
  const readElixir = (raw: unknown, label: string) => {
    if (raw === undefined) return undefined;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 10) throw new ArenaError(400, `${label} must be from 0 to 10`, "INVALID_SETTINGS");
    return raw;
  };
  const minElixir = readElixir(optionalSetting(value, "minElixir", base.minElixir), "minElixir");
  const maxElixir = readElixir(optionalSetting(value, "maxElixir", base.maxElixir), "maxElixir");
  const rawElixirRanges = optionalSetting(value, "elixirRanges", base.elixirRanges);
  if (rawElixirRanges !== undefined && !isArenaElixirRanges(rawElixirRanges)) {
    throw new ArenaError(400, "elixirRanges must contain at most 32 inclusive ranges from 0 to 10", "INVALID_SETTINGS");
  }
  const elixirRanges = rawElixirRanges as ArenaSettings["elixirRanges"];
  if (minElixir !== undefined && maxElixir !== undefined && minElixir > maxElixir) {
    throw new ArenaError(400, "minElixir cannot exceed maxElixir", "INVALID_SETTINGS");
  }
  const includeCards = stringList(optionalSetting(value, "includeCards", base.includeCards), "includeCards", catalogKeys);
  const excludeCards = stringList(optionalSetting(value, "excludeCards", base.excludeCards), "excludeCards", catalogKeys);
  const includedCardIds = cardIdList(optionalSetting(value, "includedCardIds", base.includedCardIds), "includedCardIds", catalogIds);
  const excludedCardIds = cardIdList(optionalSetting(value, "excludedCardIds", base.excludedCardIds), "excludedCardIds", catalogIds);
  const cardKinds = stringList(optionalSetting(value, "cardKinds", base.cardKinds), "cardKinds", catalogKinds);
  const rarities = stringList(optionalSetting(value, "rarities", base.rarities), "rarities", catalogRarities);
  const families = stringList(optionalSetting(value, "families", base.families), "families", catalogFamilies);
  return {
    mode: mode as ArenaMode,
    poolSize,
    pickSeconds: rawPickSeconds as number,
    timerMode,
    specialForms,
    groupedSpecialRounds,
    mirrorMode,
    battleMode,
    ...(elixirRanges !== undefined ? { elixirRanges: elixirRanges.map(({ min, max }) => ({ min, max })) } : {
      ...(minElixir === undefined ? {} : { minElixir }),
      ...(maxElixir === undefined ? {} : { maxElixir }),
    }),
    ...(includeCards === undefined ? {} : { includeCards }),
    ...(excludeCards === undefined ? {} : { excludeCards }),
    ...(includedCardIds === undefined ? {} : { includedCardIds }),
    ...(excludedCardIds === undefined ? {} : { excludedCardIds }),
    ...(cardKinds === undefined ? {} : { cardKinds }),
    ...(rarities === undefined ? {} : { rarities }),
    ...(families === undefined ? {} : { families }),
  };
};

const seededShuffle = <T>(values: readonly T[], seed: string): T[] => {
  const bytes = createHash("sha256").update(seed).digest();
  let state = bytes.readUInt32LE(0) || 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    [result[index], result[swap]] = [result[swap] as T, result[index] as T];
  }
  return result;
};

const validCatalog = (cards: readonly ArenaCard[]) => {
  const keys = new Set<string>();
  const ids = new Set<number>();
  for (const card of cards) {
    if (!card.key || keys.has(card.key) || !Number.isSafeInteger(card.id) || card.id <= 0 || ids.has(card.id)) {
      throw new Error("Arena catalog cards require unique keys and positive unique ids");
    }
    keys.add(card.key);
    ids.add(card.id);
  }
};

const cardMap = (room: InternalRoom) => new Map(room.catalogCards.map((card) => [card.key, card]));
const isMirrorRoom = (room: InternalRoom) => room.settings.mirrorMode === true;
const isPublicDraft = (room: InternalRoom) => room.settings.mode === "mega" || isMirrorRoom(room);
const totalPicksFor = (settings: ArenaSettings) => settings.mirrorMode
  ? shouldPresetMirrorCard(settings) ? ARENA_MIRROR_PICK_COUNT : deckSize
  : settings.mode === "classic" ? 8 : 16;
const mirrorRoundSchedule = (room: InternalRoom) => room.totalPicks === ARENA_MIRROR_PICK_COUNT
  ? presetMirrorGroupedSchedule
  : groupedTripleSchedule;
const mirrorPickedCount = (deck: readonly ArenaEntry[]) => deck.filter((entry) => !entry.preset).length;

const participantOwnsCard = (room: InternalRoom, seat: ArenaSeat, cardKey: string) => {
  const collection = room.participants[seat]?.collection;
  return !!collection && (collection.cards === null || collection.cards.includes(cardKey));
};

const catalogForms = (card: ArenaCard): ArenaForm[] => {
  const result = new Set<ArenaForm>();
  for (const form of card.forms) result.add(form.key);
  return forms.filter((form) => result.has(form));
};

const lockedFormForRound = (card: ArenaCard, kind: ArenaRoundKind): ArenaForm | null => {
  const available = catalogForms(card);
  if (kind === "evolution") return available.includes("evolution") ? "evolution" : null;
  if (kind === "hero_champion") {
    if (available.includes("hero")) return "hero";
    return available.includes("champion") ? "champion" : null;
  }
  return available.includes("base") ? "base" : null;
};

const ownedForms = (room: InternalRoom, seat: ArenaSeat, card: ArenaCard): ArenaForm[] => {
  if (!participantOwnsCard(room, seat, card.key)) return [];
  const available = catalogForms(card);
  if (!room.settings.specialForms) return available.includes("base") ? ["base"] : [];
  const ownership = room.participants[seat]?.collection.forms;
  if (ownership === null || ownership === undefined) return available;
  const allowed = new Set<ArenaForm>(["base", ...(ownership[card.key] ?? [])]);
  return available.filter((form) => allowed.has(form));
};

const formCounts = (deck: readonly ArenaEntry[]) => {
  let evolution = 0;
  let heroChampion = 0;
  let champion = 0;
  let special = 0;
  for (const entry of deck) {
    if (entry.form !== "base") special += 1;
    if (entry.form === "evolution") evolution += 1;
    if (entry.form === "hero" || entry.form === "champion") heroChampion += 1;
    if (entry.form === "champion") champion += 1;
  }
  return { evolution, heroChampion, champion, special };
};

const formFits = (deck: readonly ArenaEntry[], form: ArenaForm) => {
  const counts = formCounts(deck);
  if (form === "evolution") return counts.evolution < 2 && counts.special < 3;
  if (form === "hero") return counts.heroChampion < 2 && counts.special < 3;
  if (form === "champion") return counts.champion < 1 && counts.heroChampion < 2 && counts.special < 3;
  return true;
};

type SlotCounts = ReturnType<typeof formCounts>;

const nextCounts = (counts: SlotCounts, form: ArenaForm): SlotCounts | null => {
  const next = { ...counts };
  if (form !== "base") next.special += 1;
  if (form === "evolution") next.evolution += 1;
  if (form === "hero" || form === "champion") next.heroChampion += 1;
  if (form === "champion") next.champion += 1;
  if (next.evolution > 2 || next.heroChampion > 2 || next.champion > 1 || next.special > 3) return null;
  return next;
};

const countsKey = (counts: SlotCounts) => `${counts.evolution}${counts.heroChampion}${counts.champion}${counts.special}`;

const baseLegalForms = (room: InternalRoom, seat: ArenaSeat, cardKey: string, deck: readonly ArenaEntry[] = room.decks[seat]) => {
  const card = cardMap(room).get(cardKey);
  if (!card || deck.some((entry) => entry.cardKey === cardKey)) return [];
  return ownedForms(room, seat, card).filter((form) => formFits(deck, form));
};

const formStatesFor = (room: InternalRoom, seat: ArenaSeat, cardKey: string, counts: SlotCounts) => {
  const card = cardMap(room).get(cardKey);
  if (!card) return [];
  const seen = new Set<string>();
  return ownedForms(room, seat, card).flatMap((form) => {
    const next = nextCounts(counts, form);
    if (!next) return [];
    const key = countsKey(next);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ form, counts: next }];
  });
};

const tripleFormStatesFor = (room: InternalRoom, seat: ArenaSeat, cardKey: string, counts: SlotCounts, roundIndex: number) => {
  const states = formStatesFor(room, seat, cardKey, counts);
  if (!room.settings.groupedSpecialRounds) return states;
  const kind = groupedTripleSchedule[roundIndex];
  const card = cardMap(room).get(cardKey);
  if (!kind || !card) return [];
  const locked = lockedFormForRound(card, kind);
  return locked ? states.filter((state) => state.form === locked) : [];
};

const commonOwnedForms = (room: InternalRoom, card: ArenaCard): ArenaForm[] => {
  const guestForms = new Set(ownedForms(room, "b", card));
  return ownedForms(room, "a", card).filter((form) => guestForms.has(form));
};

const mirrorLockedFormForRound = (room: InternalRoom, card: ArenaCard, kind: ArenaRoundKind): ArenaForm | null => {
  const available = commonOwnedForms(room, card);
  if (kind === "evolution") return available.includes("evolution") ? "evolution" : null;
  if (kind === "hero_champion") {
    if (available.includes("hero")) return "hero";
    return available.includes("champion") ? "champion" : null;
  }
  return available.includes("base") ? "base" : null;
};

const mirrorFormStatesFor = (room: InternalRoom, cardKey: string, counts: SlotCounts, roundIndex: number) => {
  const card = cardMap(room).get(cardKey);
  if (!card) return [];
  const grouped = room.settings.mode === "triple" && room.settings.groupedSpecialRounds;
  const roundKind = grouped ? mirrorRoundSchedule(room)[roundIndex] : undefined;
  if (grouped && !roundKind) return [];
  const locked = roundKind ? mirrorLockedFormForRound(room, card, roundKind) : null;
  const seen = new Set<string>();
  return commonOwnedForms(room, card).flatMap((form) => {
    if (grouped && form !== locked) return [];
    const next = nextCounts(counts, form);
    if (!next) return [];
    const key = `${form}:${countsKey(next)}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ form, counts: next }];
  });
};

const mirrorDeck = (room: InternalRoom) => {
  const left = room.decks.a;
  const right = room.decks.b;
  if (left.length !== right.length || left.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(right[index]))) {
    throw new ArenaError(409, "Mirror room decks are no longer identical", "INVALID_MIRROR_STATE");
  }
  return left;
};

const findMirrorCompletion = (
  room: InternalRoom,
  deck: readonly ArenaEntry[],
  availableKeys: readonly string[],
): string[] | null => {
  const needed = deckSize - deck.length;
  if (needed < 0) return null;
  if (needed === 0) return [];
  const used = new Set(deck.map((entry) => entry.cardKey));
  const candidates = Array.from(new Set(availableKeys)).filter((key) => !used.has(key));
  if (candidates.length < needed) return null;
  const completedPicks = mirrorPickedCount(deck);
  const failed = new Set<string>();
  const walk = (index: number, remaining: number, counts: SlotCounts): string[] | null => {
    if (remaining === 0) return [];
    if (candidates.length - index < remaining) return null;
    const memo = `${index}|${remaining}|${countsKey(counts)}`;
    if (failed.has(memo)) return null;
    const cardKey = candidates[index] as string;
    for (const state of mirrorFormStatesFor(room, cardKey, counts, completedPicks + (needed - remaining))) {
      const tail = walk(index + 1, remaining - 1, state.counts);
      if (tail) return [cardKey, ...tail];
    }
    const skipped = walk(index + 1, remaining, counts);
    if (skipped) return skipped;
    failed.add(memo);
    return null;
  };
  return walk(0, needed, formCounts(deck));
};

const mirrorOffersCanComplete = (room: InternalRoom, deck: readonly ArenaEntry[], offers: readonly (readonly string[])[]) => {
  if (deck.length + offers.length !== deckSize) return false;
  const completedPicks = mirrorPickedCount(deck);
  const used = new Set(deck.map((entry) => entry.cardKey));
  const failed = new Set<string>();
  const walk = (index: number, counts: SlotCounts): boolean => {
    if (index === offers.length) return true;
    const memo = `${index}|${countsKey(counts)}`;
    if (failed.has(memo)) return false;
    for (const cardKey of offers[index] ?? []) {
      if (used.has(cardKey)) continue;
      used.add(cardKey);
      for (const state of mirrorFormStatesFor(room, cardKey, counts, completedPicks + index)) {
        if (walk(index + 1, state.counts)) {
          used.delete(cardKey);
          return true;
        }
      }
      used.delete(cardKey);
    }
    failed.add(memo);
    return false;
  };
  return walk(0, formCounts(deck));
};

interface CompletionAllocation {
  a: string[];
  b: string[];
}

/** Exact form-aware allocation. It returns the card identities that witness feasibility. */
const findCompletionAllocation = (
  room: InternalRoom,
  decks: Record<ArenaSeat, ArenaEntry[]>,
  availableKeys: readonly string[],
  needA = deckSize - decks.a.length,
  needB = deckSize - decks.b.length,
): CompletionAllocation | null => {
  if (needA < 0 || needB < 0) return null;
  const used = new Set([...decks.a, ...decks.b].map((entry) => entry.cardKey));
  const unique = Array.from(new Set(availableKeys)).filter(
    (key) => !used.has(key),
  );
  const initialA = formCounts(decks.a);
  const initialB = formCounts(decks.b);
  const forA = unique.filter((key) => formStatesFor(room, "a", key, initialA).length > 0);
  const forB = unique.filter((key) => formStatesFor(room, "b", key, initialB).length > 0);
  if (forA.length < needA || forB.length < needB) return null;
  const union = new Set([...forA, ...forB]);
  if (union.size < needA + needB) return null;
  const setA = new Set(forA);
  const setB = new Set(forB);
  const candidates = unique
    .filter((key) => union.has(key))
    .map((key, index) => ({ key, index, seats: Number(setA.has(key)) + Number(setB.has(key)) }))
    .sort((left, right) => left.seats - right.seats || left.index - right.index)
    .map(({ key }) => key);
  const failed = new Set<string>();
  const walk = (
    index: number,
    aNeeded: number,
    bNeeded: number,
    countsA: SlotCounts,
    countsB: SlotCounts,
  ): CompletionAllocation | null => {
    if (aNeeded === 0 && bNeeded === 0) return { a: [], b: [] };
    if (candidates.length - index < aNeeded + bNeeded) return null;
    const memo = `${index}|${aNeeded}|${bNeeded}|${countsKey(countsA)}|${countsKey(countsB)}`;
    if (failed.has(memo)) return null;
    const cardKey = candidates[index] as string;
    if (aNeeded > 0) {
      for (const state of formStatesFor(room, "a", cardKey, countsA)) {
        const tail = walk(index + 1, aNeeded - 1, bNeeded, state.counts, countsB);
        if (tail) return { a: [cardKey, ...tail.a], b: tail.b };
      }
    }
    if (bNeeded > 0) {
      for (const state of formStatesFor(room, "b", cardKey, countsB)) {
        const tail = walk(index + 1, aNeeded, bNeeded - 1, countsA, state.counts);
        if (tail) return { a: tail.a, b: [cardKey, ...tail.b] };
      }
    }
    const skipped = walk(index + 1, aNeeded, bNeeded, countsA, countsB);
    if (skipped) return skipped;
    failed.add(memo);
    return null;
  };
  return walk(0, needA, needB, initialA, initialB);
};

const canComplete = (room: InternalRoom, decks: Record<ArenaSeat, ArenaEntry[]>, availableKeys: readonly string[]) =>
  findCompletionAllocation(room, decks, availableKeys) !== null;

const filteredCatalogKeys = (room: InternalRoom) => {
  return filterArenaCards(room.catalogCards, room.settings).map((card) => card.key);
};

const allocateOfferCards = (room: InternalRoom, shuffled: readonly string[], quota: number): CompletionAllocation | null => {
  const emptyCounts = formCounts([]);
  const forA = shuffled.filter((key) => formStatesFor(room, "a", key, emptyCounts).length > 0);
  const forB = shuffled.filter((key) => formStatesFor(room, "b", key, emptyCounts).length > 0);
  const setA = new Set(forA);
  const setB = new Set(forB);
  const hasBase = (seat: ArenaSeat, key: string) => {
    const card = cardMap(room).get(key);
    return !!card && ownedForms(room, seat, card).includes("base");
  };
  const onlyA = shuffled.filter((key) => setA.has(key) && !setB.has(key)).sort((left, right) => Number(hasBase("a", right)) - Number(hasBase("a", left)));
  const onlyB = shuffled.filter((key) => setB.has(key) && !setA.has(key)).sort((left, right) => Number(hasBase("b", right)) - Number(hasBase("b", left)));
  const both = shuffled.filter((key) => setA.has(key) && setB.has(key));
  const aOverlap = Math.max(0, quota - onlyA.length);
  const bOverlap = Math.max(0, quota - onlyB.length);
  if (forA.length < quota || forB.length < quota || aOverlap + bOverlap > both.length) return null;
  const bothForA = [...both].sort((left, right) => Number(hasBase("a", right)) - Number(hasBase("a", left)));
  const chosenAOverlap = bothForA.slice(0, aOverlap);
  const usedByA = new Set(chosenAOverlap);
  const bothForB = both.filter((key) => !usedByA.has(key)).sort((left, right) => Number(hasBase("b", right)) - Number(hasBase("b", left)));
  return {
    a: [...onlyA.slice(0, quota - aOverlap), ...chosenAOverlap],
    b: [...onlyB.slice(0, quota - bOverlap), ...bothForB.slice(0, bOverlap)],
  };
};

interface GroupedTripleSlot {
  id: number;
  seat: ArenaSeat;
  roundIndex: number;
  position: number;
  kind: ArenaRoundKind;
  candidates: string[];
}

/** Exact bipartite allocation of 48 unique cards into both locked Triple schedules. */
const groupedTripleOffers = (room: InternalRoom, shuffled: readonly string[]): Record<ArenaSeat, string[][]> | null => {
  const cards = cardMap(room);
  const slots: GroupedTripleSlot[] = [];
  for (const seat of seats) {
    for (let roundIndex = 0; roundIndex < groupedTripleSchedule.length; roundIndex += 1) {
      const kind = groupedTripleSchedule[roundIndex] as ArenaRoundKind;
      for (let position = 0; position < 3; position += 1) {
        const candidates = shuffled.filter((cardKey) => {
          const card = cards.get(cardKey);
          if (!card) return false;
          const locked = lockedFormForRound(card, kind);
          return locked !== null && ownedForms(room, seat, card).includes(locked);
        });
        slots.push({ id: slots.length, seat, roundIndex, position, kind, candidates });
      }
    }
  }
  if (slots.some((slot) => slot.candidates.length === 0)) return null;
  const cardToSlot = new Map<string, number>();
  const slotToCard = new Map<number, string>();
  const byId = new Map(slots.map((slot) => [slot.id, slot]));
  const assign = (slotId: number, seenCards: Set<string>): boolean => {
    const slot = byId.get(slotId);
    if (!slot) return false;
    for (const cardKey of slot.candidates) {
      if (seenCards.has(cardKey)) continue;
      seenCards.add(cardKey);
      const previousSlot = cardToSlot.get(cardKey);
      if (previousSlot === undefined || assign(previousSlot, seenCards)) {
        cardToSlot.set(cardKey, slotId);
        slotToCard.set(slotId, cardKey);
        return true;
      }
    }
    return false;
  };
  const constrainedFirst = [...slots].sort((left, right) => left.candidates.length - right.candidates.length || left.id - right.id);
  for (const slot of constrainedFirst) if (!assign(slot.id, new Set())) return null;
  const offers: Record<ArenaSeat, string[][]> = {
    a: groupedTripleSchedule.map(() => []),
    b: groupedTripleSchedule.map(() => []),
  };
  for (const slot of slots) {
    const cardKey = slotToCard.get(slot.id);
    if (!cardKey) return null;
    offers[slot.seat][slot.roundIndex]![slot.position] = cardKey;
  }
  return offers;
};

interface GroupedMirrorSlot {
  id: number;
  roundIndex: number;
  position: number;
  candidates: string[];
}

/** Exact allocation of unique, commonly owned cards into the shared locked Triple schedule. */
const groupedMirrorOffers = (room: InternalRoom, shuffled: readonly string[]): string[][] | null => {
  const cards = cardMap(room);
  const schedule = mirrorRoundSchedule(room);
  const slots: GroupedMirrorSlot[] = [];
  for (let roundIndex = 0; roundIndex < schedule.length; roundIndex += 1) {
    const kind = schedule[roundIndex] as ArenaRoundKind;
    for (let position = 0; position < 3; position += 1) {
      const candidates = shuffled.filter((cardKey) => {
        const card = cards.get(cardKey);
        return !!card && mirrorLockedFormForRound(room, card, kind) !== null;
      });
      slots.push({ id: slots.length, roundIndex, position, candidates });
    }
  }
  if (slots.some((slot) => slot.candidates.length === 0)) return null;
  const cardToSlot = new Map<string, number>();
  const slotToCard = new Map<number, string>();
  const byId = new Map(slots.map((slot) => [slot.id, slot]));
  const assign = (slotId: number, seenCards: Set<string>): boolean => {
    const slot = byId.get(slotId);
    if (!slot) return false;
    for (const cardKey of slot.candidates) {
      if (seenCards.has(cardKey)) continue;
      seenCards.add(cardKey);
      const previous = cardToSlot.get(cardKey);
      if (previous === undefined || assign(previous, seenCards)) {
        cardToSlot.set(cardKey, slotId);
        slotToCard.set(slotId, cardKey);
        return true;
      }
    }
    return false;
  };
  for (const slot of [...slots].sort((left, right) => left.candidates.length - right.candidates.length || left.id - right.id)) {
    if (!assign(slot.id, new Set())) return null;
  }
  const offers = schedule.map(() => [] as string[]);
  for (const slot of slots) {
    const cardKey = slotToCard.get(slot.id);
    if (!cardKey) return null;
    offers[slot.roundIndex]![slot.position] = cardKey;
  }
  return mirrorOffersCanComplete(room, room.decks.a, offers) ? offers : null;
};

const normalMirrorOffers = (room: InternalRoom, shuffled: readonly string[], offerSize: number): string[][] | null => {
  const emptyCounts = formCounts([]);
  const commonKeys = shuffled.filter((key) => mirrorFormStatesFor(room, key, emptyCounts, 0).length > 0);
  const pickCount = deckSize - room.decks.a.length;
  const offerCardCount = pickCount * offerSize;
  if (commonKeys.length < offerCardCount) return null;
  const witness = findMirrorCompletion(room, room.decks.a, commonKeys);
  if (!witness || witness.length !== pickCount) return null;
  const witnessSet = new Set(witness);
  const fillers = commonKeys.filter((key) => !witnessSet.has(key)).slice(0, offerCardCount - pickCount);
  if (fillers.length !== offerCardCount - pickCount) return null;
  const offers = witness.map((cardKey, roundIndex) => seededShuffle(
    [cardKey, ...fillers.slice(roundIndex * (offerSize - 1), (roundIndex + 1) * (offerSize - 1))],
    `${room.seed}:${room.round}:mirror-offer:${roundIndex}`,
  ));
  return mirrorOffersCanComplete(room, room.decks.a, offers) ? offers : null;
};

const megaPickOrderFor = (starter: ArenaSeat): ArenaSeat[] =>
  megaPickOrder.map((canonicalSeat) => canonicalSeat === "a" ? starter : otherSeat(starter));

const availableAfterMegaPick = (room: InternalRoom, cardKey: string) =>
  room.boardKeys.filter((key) => key !== cardKey && !room.selected[key]);

const legalMegaForms = (room: InternalRoom, seat: ArenaSeat, cardKey: string) => {
  if (room.selected[cardKey]) return [];
  return baseLegalForms(room, seat, cardKey).filter((form) => {
    const decks = clone(room.decks);
    decks[seat].push({ cardKey, form, pickedBy: seat });
    return canComplete(room, decks, availableAfterMegaPick(room, cardKey));
  });
};

const tripleLaneCanComplete = (room: InternalRoom, seat: ArenaSeat, deck: readonly ArenaEntry[], offers: readonly string[][]) => {
  if (deck.length + offers.length !== deckSize) return false;
  const failed = new Set<string>();
  const walk = (index: number, counts: SlotCounts): boolean => {
    if (index === offers.length) return true;
    const memo = `${index}|${countsKey(counts)}`;
    if (failed.has(memo)) return false;
    for (const cardKey of offers[index] ?? []) {
      for (const state of tripleFormStatesFor(room, seat, cardKey, counts, deck.length + index)) {
        if (walk(index + 1, state.counts)) return true;
      }
    }
    failed.add(memo);
    return false;
  };
  return walk(0, formCounts(deck));
};

const legalTripleForms = (room: InternalRoom, seat: ArenaSeat, cardKey: string) => {
  const kind = room.settings.groupedSpecialRounds ? groupedTripleSchedule[room.decks[seat].length] : undefined;
  const card = cardMap(room).get(cardKey);
  const locked = kind && card ? lockedFormForRound(card, kind) : null;
  return baseLegalForms(room, seat, cardKey).filter((form) => (!kind || form === locked) && (() => {
    const deck = [...room.decks[seat], { cardKey, form, pickedBy: seat } satisfies ArenaEntry];
    return tripleLaneCanComplete(room, seat, deck, room.offerQueues[seat]);
  })());
};

const legalMirrorForms = (room: InternalRoom, cardKey: string) => {
  const deck = mirrorDeck(room);
  if (deck.some((entry) => entry.cardKey === cardKey) || room.selected[cardKey]) return [];
  return mirrorFormStatesFor(room, cardKey, formCounts(deck), mirrorPickedCount(deck)).flatMap((state) => {
    const nextDeck = [...deck, { cardKey, form: state.form, pickedBy: room.activeSeat ?? "a" } satisfies ArenaEntry];
    const completable = room.settings.mode === "mega"
      ? findMirrorCompletion(room, nextDeck, availableAfterMegaPick(room, cardKey)) !== null
      : mirrorOffersCanComplete(room, nextDeck, room.sharedOfferQueue);
    return completable ? [state.form] : [];
  });
};

interface ClassicDirection {
  selectedForms: ArenaForm[];
  receivedBySelectedForm: Map<ArenaForm, ArenaForm>;
}

interface ClassicDecision {
  picker: ArenaSeat;
  offer: string[];
}

const unresolvedClassicDecisions = (room: InternalRoom, excludeCurrent?: ArenaSeat): ClassicDecision[] =>
  seats.flatMap((seat) => [
    ...(seat !== excludeCurrent && room.currentOffers[seat].length ? [{ picker: seat, offer: room.currentOffers[seat] }] : []),
    ...room.offerQueues[seat].map((offer) => ({ picker: seat, offer })),
  ]);

const classicCanComplete = (room: InternalRoom, decks: Record<ArenaSeat, ArenaEntry[]>, decisions: readonly ClassicDecision[]) => {
  if (decks.a.length + decisions.length !== deckSize || decks.b.length + decisions.length !== deckSize) return false;
  const failed = new Set<string>();
  const walk = (index: number, countsA: SlotCounts, countsB: SlotCounts): boolean => {
    if (index === decisions.length) return true;
    const memo = `${index}|${countsKey(countsA)}|${countsKey(countsB)}`;
    if (failed.has(memo)) return false;
    const decision = decisions[index] as ClassicDecision;
    const [first, second] = decision.offer;
    if (!first || !second) return false;
    for (const [selectedKey, receivedKey] of [[first, second], [second, first]] as const) {
      const opponent = otherSeat(decision.picker);
      const pickerCounts = decision.picker === "a" ? countsA : countsB;
      const opponentCounts = opponent === "a" ? countsA : countsB;
      for (const selected of formStatesFor(room, decision.picker, selectedKey, pickerCounts)) {
        for (const received of formStatesFor(room, opponent, receivedKey, opponentCounts)) {
          const nextA = decision.picker === "a" ? selected.counts : received.counts;
          const nextB = decision.picker === "b" ? selected.counts : received.counts;
          if (walk(index + 1, nextA, nextB)) return true;
        }
      }
    }
    failed.add(memo);
    return false;
  };
  return walk(0, formCounts(decks.a), formCounts(decks.b));
};

const classicDirection = (room: InternalRoom, picker: ArenaSeat, selectedKey: string, receivedKey: string): ClassicDirection => {
  const opponent = otherSeat(picker);
  const selectedForms: ArenaForm[] = [];
  const receivedBySelectedForm = new Map<ArenaForm, ArenaForm>();
  for (const selectedForm of baseLegalForms(room, picker, selectedKey)) {
    for (const receivedForm of baseLegalForms(room, opponent, receivedKey)) {
      const decks = clone(room.decks);
      decks[picker].push({ cardKey: selectedKey, form: selectedForm, pickedBy: picker });
      decks[opponent].push({ cardKey: receivedKey, form: receivedForm, pickedBy: picker, received: true });
      if (classicCanComplete(room, decks, unresolvedClassicDecisions(room, picker))) {
        selectedForms.push(selectedForm);
        receivedBySelectedForm.set(selectedForm, receivedForm);
        break;
      }
    }
  }
  return { selectedForms, receivedBySelectedForm };
};

const dealRoundRobin = (keys: readonly string[], offerCount: number, offerSize: number) => {
  const offers = Array.from({ length: offerCount }, () => [] as string[]);
  keys.forEach((key, index) => offers[index % offerCount]?.push(key));
  if (offers.some((offer) => offer.length !== offerSize)) throw new ArenaError(409, "Private offer deal is incomplete", "POOL_INFEASIBLE");
  return offers;
};

const seatPickCount = (room: InternalRoom, seat: ArenaSeat) => room.events.filter((event) => event.seat === seat).length;

const completePrivateIfDone = (room: InternalRoom) => {
  const target = room.settings.mode === "classic" ? 4 : 8;
  if (seats.every((seat) => seatPickCount(room, seat) >= target)) {
    room.phase = "complete";
    room.currentOffers = { a: [], b: [] };
    room.interactiveAtBySeat = { a: null, b: null };
    room.deadlineAtBySeat = { a: null, b: null };
    room.wholeDraftDeadlineAt = null;
    return true;
  }
  return false;
};

const deadlineFor = (room: InternalRoom, interactiveAt: number) =>
  room.settings.timerMode === "whole_draft"
    ? room.wholeDraftDeadlineAt
    : interactiveAt + room.settings.pickSeconds * 1_000;

const advanceSeat = (room: InternalRoom, seat: ArenaSeat, now: number, presentationDelayMs: number) => {
  if (room.settings.mode === "mega") {
    const order = megaPickOrderFor(room.megaStarter ?? "a");
    if (room.events.length >= order.length) {
      room.phase = "complete";
      room.activeSeat = null;
      room.pickNumber = room.totalPicks;
      room.interactiveAt = null;
      room.deadlineAt = null;
      return;
    }
    room.activeSeat = order[room.events.length] as ArenaSeat;
    room.pickNumber = room.events.length + 1;
    room.interactiveAt = now + presentationDelayMs;
    room.deadlineAt = deadlineFor(room, room.interactiveAt);
    return;
  }
  if (completePrivateIfDone(room)) return;
  const target = room.settings.mode === "classic" ? 4 : 8;
  if (seatPickCount(room, seat) >= target) {
    room.currentOffers[seat] = [];
    room.interactiveAtBySeat[seat] = null;
    room.deadlineAtBySeat[seat] = null;
    return;
  }
  const offer = room.offerQueues[seat].shift();
  if (!offer) throw new ArenaError(409, "Private offer queue ended early", "INVALID_STATE");
  room.currentOffers[seat] = offer;
  room.offerRevision[seat] = room.revision;
  room.interactiveAtBySeat[seat] = now + presentationDelayMs;
  room.deadlineAtBySeat[seat] = deadlineFor(room, room.interactiveAtBySeat[seat]!);
};

const preparePrivateLanes = (room: InternalRoom) => {
  room.activeSeat = null;
  room.interactiveAt = null;
  room.deadlineAt = null;
  for (const seat of seats) {
    const offer = room.offerQueues[seat].shift();
    if (!offer) throw new ArenaError(409, "Private offer queue ended early", "INVALID_STATE");
    room.currentOffers[seat] = offer;
    room.interactiveAtBySeat[seat] = null;
    room.deadlineAtBySeat[seat] = null;
  }
};

const activatePreparedDraft = (room: InternalRoom, now: number, initialDealMs: number) => {
  room.phase = "drafting";
  room.startedAt = now;
  room.loadDeadlineAt = null;
  room.wholeDraftDeadlineAt = room.settings.timerMode === "whole_draft"
    ? now + initialDealMs + room.settings.pickSeconds * 1_000
    : null;
  if (isMirrorRoom(room)) {
    room.activeSeat = mirrorPickOrder[0] as ArenaSeat;
    room.pickNumber = 1;
    room.interactiveAt = now + initialDealMs;
    room.deadlineAt = deadlineFor(room, room.interactiveAt);
    return;
  }
  if (room.settings.mode === "mega") {
    advanceMega(room, now, initialDealMs);
    return;
  }
  for (const seat of seats) {
    room.offerRevision[seat] = room.revision + 1;
    room.interactiveAtBySeat[seat] = now + initialDealMs;
    room.deadlineAtBySeat[seat] = deadlineFor(room, room.interactiveAtBySeat[seat]!);
  }
};

const advanceMirror = (room: InternalRoom, now: number, presentationDelayMs: number) => {
  if (room.events.length >= room.totalPicks) {
    room.phase = "complete";
    room.activeSeat = null;
    room.pickNumber = room.totalPicks;
    room.interactiveAt = null;
    room.deadlineAt = null;
    room.wholeDraftDeadlineAt = null;
    return;
  }
  if (room.settings.mode !== "mega") {
    const offer = room.sharedOfferQueue.shift();
    if (!offer) throw new ArenaError(409, "Shared offer queue ended early", "INVALID_MIRROR_STATE");
    room.boardKeys = offer;
  }
  const nextSeat = mirrorPickOrder[room.events.length];
  if (!nextSeat) throw new ArenaError(409, "Mirror pick order ended early", "INVALID_MIRROR_STATE");
  room.activeSeat = nextSeat;
  room.pickNumber = room.events.length + 1;
  room.interactiveAt = now + presentationDelayMs;
  room.deadlineAt = deadlineFor(room, room.interactiveAt);
};

const advanceMega = (room: InternalRoom, now: number, presentationDelayMs: number) => {
  const order = megaPickOrderFor(room.megaStarter ?? "a");
  if (room.events.length >= order.length) {
    room.phase = "complete";
    room.activeSeat = null;
    room.pickNumber = room.totalPicks;
    room.interactiveAt = null;
    room.deadlineAt = null;
    room.wholeDraftDeadlineAt = null;
    return;
  }
  room.activeSeat = order[room.events.length] as ArenaSeat;
  room.pickNumber = room.events.length + 1;
  room.interactiveAt = now + presentationDelayMs;
  room.deadlineAt = deadlineFor(room, room.interactiveAt);
};

const prepareDraft = (room: InternalRoom, now: number, loadingTimeoutMs: number) => {
  const filtered = filteredCatalogKeys(room).filter((key) => !isMirrorRoom(room) || key !== ARENA_MIRROR_CARD_KEY);
  const shuffled = seededShuffle(filtered, `${room.seed}:${room.round}:${room.settings.mode}`);
  room.decks = { a: [], b: [] };
  room.events = [];
  room.selected = {};
  room.currentOffers = { a: [], b: [] };
  room.offerQueues = { a: [], b: [] };
  room.sharedOfferQueue = [];
  room.offerRevision = { a: room.revision + 1, b: room.revision + 1 };
  room.interactiveAtBySeat = { a: null, b: null };
  room.deadlineAtBySeat = { a: null, b: null };
  room.totalPicks = totalPicksFor(room.settings);
  room.startedAt = null;
  room.phase = "loading";
  room.loadDeadlineAt = now + loadingTimeoutMs;
  room.activeSeat = null;
  room.pickNumber = 0;
  room.interactiveAt = null;
  room.deadlineAt = null;
  room.wholeDraftDeadlineAt = null;
  for (const participant of Object.values(room.participants)) if (participant) participant.loaded = participant.bot;
  if (isMirrorRoom(room)) {
    const cards = cardMap(room);
    if (shouldPresetMirrorCard(room.settings)) {
      const mirror = cards.get(ARENA_MIRROR_CARD_KEY);
      if (!mirror || !catalogForms(mirror).includes("base")) {
        throw new ArenaError(409, "Mirror mode requires the base Mirror card in this room's catalog", "MIRROR_CARD_UNAVAILABLE");
      }
      if (seats.some((seat) => !ownedForms(room, seat, mirror).includes("base"))) {
        throw new ArenaError(409, "Both players must own the base Mirror card for Mirror mode", "MIRROR_CARD_NOT_OWNED");
      }
      const preset = { cardKey: ARENA_MIRROR_CARD_KEY, form: "base" as const, pickedBy: "a" as const, preset: true };
      room.decks = { a: [{ ...preset }], b: [{ ...preset }] };
    }
    const common = shuffled.filter((key) => {
      const card = cards.get(key);
      return !!card && commonOwnedForms(room, card).length > 0;
    });
    if (room.settings.mode === "mega") {
      const poolSize = effectiveMegaPoolSize(room.settings, common.length);
      if (poolSize < ARENA_MEGA_MIN_POOL_SIZE) {
        throw new ArenaError(409, "Mirror Mega requires at least sixteen commonly owned eligible cards", "MIRROR_POOL_TOO_SMALL");
      }
      const witness = findMirrorCompletion(room, room.decks.a, common);
      if (!witness) throw new ArenaError(409, "The shared collection cannot complete a legal Mirror deck", "MIRROR_POOL_INFEASIBLE");
      const selected = new Set(witness);
      for (const key of common) {
        if (selected.size >= poolSize) break;
        selected.add(key);
      }
      room.boardKeys = common.filter((key) => selected.has(key));
      if (room.boardKeys.length !== poolSize || findMirrorCompletion(room, room.decks.a, room.boardKeys) === null) {
        throw new ArenaError(409, "Mirror Mega pool cannot complete a shared legal deck", "MIRROR_POOL_INFEASIBLE");
      }
    } else {
      const offerSize = room.settings.mode === "triple" ? 3 : 2;
      const offers = room.settings.mode === "triple" && room.settings.groupedSpecialRounds
        ? groupedMirrorOffers(room, common)
        : normalMirrorOffers(room, common, offerSize);
      if (!offers) {
        const required = room.totalPicks * offerSize;
        throw new ArenaError(
          409,
          `Mirror ${room.settings.mode === "triple" ? "Triple" : "Classic"} requires ${required} unique commonly owned, form-compatible offer cards`,
          room.settings.groupedSpecialRounds ? "GROUPED_MIRROR_POOL_INFEASIBLE" : "MIRROR_POOL_INFEASIBLE",
        );
      }
      room.boardKeys = offers[0] as string[];
      room.sharedOfferQueue = offers.slice(1);
    }
    return;
  }
  if (room.settings.mode === "mega") {
    const poolSize = effectiveMegaPoolSize(room.settings, shuffled.length);
    if (poolSize < ARENA_MEGA_MIN_POOL_SIZE) throw new ArenaError(409, "Mega requires at least sixteen eligible cards", "POOL_TOO_SMALL");
    const support = findCompletionAllocation(room, room.decks, shuffled);
    if (!support) throw new ArenaError(409, "The two declared collections cannot both complete a legal deck", "COLLECTION_INFEASIBLE");
    const selected = new Set([...support.a, ...support.b]);
    for (const key of shuffled) {
      if (selected.size >= poolSize) break;
      selected.add(key);
    }
    room.boardKeys = shuffled.filter((key) => selected.has(key));
    room.remainingPool = [];
    if (room.boardKeys.length !== poolSize || !canComplete(room, room.decks, room.boardKeys)) {
      throw new ArenaError(409, "Mega pool cannot support both declared collections", "POOL_INFEASIBLE");
    }
  } else if (room.settings.mode === "triple") {
    room.boardKeys = [];
    room.remainingPool = [];
    if (room.settings.groupedSpecialRounds) {
      const groupedOffers = shuffled.length >= 48 ? groupedTripleOffers(room, shuffled) : null;
      if (!groupedOffers) {
        throw new ArenaError(
          409,
          "Grouped Triple requires enough owned Evolution, Hero or Champion, and base cards for both players",
          "GROUPED_POOL_INFEASIBLE",
        );
      }
      room.offerQueues = groupedOffers;
    } else {
      if (shuffled.length < 48) throw new ArenaError(409, "triple requires at least 48 filtered cards", "POOL_TOO_SMALL");
      const allocation = allocateOfferCards(room, shuffled, 24);
      if (!allocation) throw new ArenaError(409, "The declared collections cannot support two private Triple lanes", "POOL_INFEASIBLE");
      const priority = (seat: ArenaSeat, key: string) => ownedForms(room, seat, cardMap(room).get(key) as ArenaCard).includes("base") ? 1 : 0;
      room.offerQueues = {
        a: dealRoundRobin([...allocation.a].sort((left, right) => priority("a", left) - priority("a", right)), 8, 3),
        b: dealRoundRobin([...allocation.b].sort((left, right) => priority("b", left) - priority("b", right)), 8, 3),
      };
    }
    if (!tripleLaneCanComplete(room, "a", [], room.offerQueues.a) || !tripleLaneCanComplete(room, "b", [], room.offerQueues.b)) {
      throw new ArenaError(409, "Triple offers cannot satisfy intrinsic form slots", "POOL_INFEASIBLE");
    }
    preparePrivateLanes(room);
    room.offerRevision = { a: room.revision + 1, b: room.revision + 1 };
  } else {
    room.boardKeys = [];
    room.remainingPool = [];
    const shared = shuffled.filter((key) => {
      const card = cardMap(room).get(key) as ArenaCard;
      return ownedForms(room, "a", card).length > 0 && ownedForms(room, "b", card).length > 0;
    }).sort((left, right) => {
      const leftCard = cardMap(room).get(left) as ArenaCard;
      const rightCard = cardMap(room).get(right) as ArenaCard;
      const leftBase = Number(ownedForms(room, "a", leftCard).includes("base") && ownedForms(room, "b", leftCard).includes("base"));
      const rightBase = Number(ownedForms(room, "a", rightCard).includes("base") && ownedForms(room, "b", rightCard).includes("base"));
      return rightBase - leftBase;
    });
    const allocation = findCompletionAllocation(room, room.decks, shared);
    if (!allocation || allocation.a.length !== 8 || allocation.b.length !== 8) {
      throw new ArenaError(409, "Classic requires sixteen form-compatible shared cards", "POOL_INFEASIBLE");
    }
    const forcedRank = (seat: ArenaSeat, key: string) => ownedForms(room, seat, cardMap(room).get(key) as ArenaCard).includes("base") ? 1 : 0;
    allocation.a.sort((left, right) => forcedRank("a", left) - forcedRank("a", right));
    allocation.b.sort((left, right) => forcedRank("b", left) - forcedRank("b", right));
    const pairs = allocation.a.map((key, index) => [key, allocation.b[index] as string]);
    room.offerQueues = { a: pairs.slice(0, 4), b: pairs.slice(4) };
    if (!classicCanComplete(room, room.decks, unresolvedClassicDecisions(room))) {
      throw new ArenaError(409, "Classic offers cannot satisfy intrinsic form slots", "POOL_INFEASIBLE");
    }
    preparePrivateLanes(room);
    room.offerRevision = { a: room.revision + 1, b: room.revision + 1 };
  }
};

const safeExportEntries = (entries: readonly ArenaEntry[]) => {
  const remaining = [...entries];
  const take = (predicate: (entry: ArenaEntry) => boolean) => {
    const index = remaining.findIndex(predicate);
    return index < 0 ? undefined : remaining.splice(index, 1)[0];
  };
  const evolution = take((entry) => entry.form === "evolution");
  const heroChampion = take((entry) => entry.form === "hero" || entry.form === "champion");
  const wild = take((entry) => entry.form !== "base");
  const takeBase = () => take((entry) => entry.form === "base");
  return [evolution ?? takeBase(), heroChampion ?? takeBase(), wild ?? takeBase(), ...remaining].filter((entry): entry is ArenaEntry => !!entry);
};

const exportIssueForDeck = (entries: readonly ArenaEntry[], cards: ReadonlyMap<string, ArenaCard>, settings: ArenaSettings): string | null => {
  if (entries.length !== deckSize) return "A completed deck must contain exactly eight cards before it can be exported.";
  if (new Set(entries.map((entry) => entry.cardKey)).size !== deckSize) return "A completed deck cannot export duplicate card identities.";
  const ids = new Set<number>();
  for (const entry of entries) {
    const card = cards.get(entry.cardKey);
    if (!card) return `The completed deck contains unavailable card ${entry.cardKey}.`;
    if (!card.forms.some((form) => form.key === entry.form)) return `${card.name} does not support its saved ${entry.form} form.`;
    if (ids.has(card.id)) return "A completed deck cannot export duplicate card ids.";
    ids.add(card.id);
  }
  if (isChaosInfiniteElixirBattleMode(settings.battleMode)) {
    const unavailable = entries.flatMap((entry) => {
      const card = cards.get(entry.cardKey);
      return card && !isChaosInfiniteElixirSupportedCard(card) ? [card.name] : [];
    });
    const special = entries.flatMap((entry) => {
      const card = cards.get(entry.cardKey);
      return entry.form !== "base" ? [`${card?.name ?? entry.cardKey} (${entry.form})`] : [];
    });
    const conflicts = [
      ...(unavailable.length ? [`unavailable cards: ${unavailable.join(", ")}`] : []),
      ...(special.length ? [`non-base forms: ${special.join(", ")}`] : []),
    ];
    if (conflicts.length) {
      return `C.H.A.O.S Infinite Elixir cannot export this preserved deck because it contains ${conflicts.join("; ")}. Draft again with the current 51-card, base-only rules.`;
    }
  }
  const counts = formCounts(entries);
  if (counts.champion > 1) return "A deck can contain at most one Champion. Draft again to create a legal export.";
  if (counts.heroChampion > 2) return "A deck can contain at most two Hero or Champion forms combined. Draft again to create a legal export.";
  if (counts.evolution > 2) return "A deck can contain at most two Evolution forms. Draft again to create a legal export.";
  if (counts.special > 3) return "A deck can contain at most three special forms. Draft again to create a legal export.";
  return null;
};

export const createArenaService = (options: ArenaServiceOptions): ArenaService => {
  if (!options.catalogVersion.trim()) throw new Error("catalogVersion is required");
  validCatalog(options.catalog);
  const currentCatalog = clone(options.catalog);
  const currentCatalogUpdatedAt = options.catalogUpdatedAt ?? new Date((options.now ?? Date.now)()).toISOString();
  const catalogKeys = new Set(currentCatalog.map((card) => card.key));
  const now = options.now ?? Date.now;
  const random = options.randomBytes ?? cryptoRandomBytes;
  const roomTtlMs = options.roomTtlMs ?? 7 * 24 * 60 * 60 * 1_000;
  const presentationDelayMs = options.presentationDelayMs ?? 250;
  const initialDealMsFor = (mode: ArenaMode) => options.initialDealMs ?? (mode === "mega" ? 2_400 : 600);
  const botDelayMs = options.botDelayMs ?? 900;
  const loadingTimeoutMs = options.loadingTimeoutMs ?? 180_000;
  const databasePath = options.databasePath ?? path.resolve(process.cwd(), "data/private/arena.sqlite");
  if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS arena_rooms (
      id TEXT PRIMARY KEY,
      invite_code TEXT NOT NULL UNIQUE,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS arena_credentials (
      room_id TEXT NOT NULL,
      seat TEXT NOT NULL CHECK (seat IN ('a','b')),
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, seat),
      FOREIGN KEY (room_id) REFERENCES arena_rooms(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS arena_commands (
      room_id TEXT NOT NULL,
      seat TEXT NOT NULL,
      command_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      result_revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, seat, command_id),
      FOREIGN KEY (room_id) REFERENCES arena_rooms(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS arena_invited_operations (
      operation_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      room_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (room_id) REFERENCES arena_rooms(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS arena_mega_starter_pairs (
      pair_key TEXT PRIMARY KEY,
      next_starter TEXT NOT NULL CHECK (next_starter IN ('a','b')),
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS arena_rooms_expiry ON arena_rooms(expires_at);
  `);

  let closed = false;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const subscribers = new Map<string, Map<ArenaSeat, Set<{ send: (view: ArenaView) => void; close: () => void }>>>();

  const ensureOpen = () => {
    if (closed) throw new ArenaError(503, "Arena service is closed", "SERVICE_CLOSED");
  };

  const loadRoom = (roomId: string): InternalRoom => {
    const row = db.prepare("SELECT state_json FROM arena_rooms WHERE id = ?").get(roomId) as unknown as RoomRow | undefined;
    if (!row) throw new ArenaError(404, "Room not found", "ROOM_NOT_FOUND");
    const room = decodeRoom(row.state_json);
    if (room.expiresAt <= now()) throw new ArenaError(410, "Room expired", "ROOM_EXPIRED");
    return room;
  };

  const saveRoom = (room: InternalRoom) => {
    db.prepare("UPDATE arena_rooms SET state_json = ?, updated_at = ?, expires_at = ? WHERE id = ?").run(
      JSON.stringify(room),
      room.updatedAt,
      room.expiresAt,
      room.id,
    );
  };

  /**
   * Commit a Mega starter exactly when a round becomes interactive. A failed
   * load, a retry, or a duplicate command never reaches this function's commit.
   * A pair cursor is deliberately opaque and only supplied by authenticated
   * social identity; anonymous names/tags are not an identity signal.
   */
  const commitMegaStarter = (room: InternalRoom) => {
    if (room.settings.mode !== "mega" || isMirrorRoom(room)) return;
    if (room.megaStarter === null) {
      const pair = room.megaPairKey
        ? db.prepare("SELECT next_starter FROM arena_mega_starter_pairs WHERE pair_key = ?").get(room.megaPairKey) as unknown as MegaPairRow | undefined
        : undefined;
      room.megaStarter = pair?.next_starter ?? ((random(1)[0] ?? 0) % 2 === 0 ? "a" : "b");
    }
    if (room.megaPairKey) {
      db.prepare(`INSERT INTO arena_mega_starter_pairs(pair_key, next_starter, updated_at) VALUES(?,?,?)
        ON CONFLICT(pair_key) DO UPDATE SET next_starter=excluded.next_starter, updated_at=excluded.updated_at`)
        .run(room.megaPairKey, otherSeat(room.megaStarter), now());
    }
  };

  const credentialSeat = (roomId: string, token: string): ArenaSeat => {
    if (!token || token.length > 256) throw new ArenaError(401, "Valid room credentials are required", "UNAUTHORIZED");
    const row = db.prepare("SELECT room_id, seat FROM arena_credentials WHERE room_id = ? AND token_hash = ?").get(roomId, sha256(token)) as unknown as CredentialRow | undefined;
    if (!row) throw new ArenaError(401, "Valid room credentials are required", "UNAUTHORIZED");
    return row.seat;
  };

  const connected = (roomId: string, seat: ArenaSeat) => (subscribers.get(roomId)?.get(seat)?.size ?? 0) > 0;

  const viewFor = (room: InternalRoom, viewer: ArenaSeat): ArenaView => {
    const cards = cardMap(room);
    const publicDraft = isPublicDraft(room);
    const privateMode = !publicDraft;
    const viewerOffer = room.currentOffers[viewer];
    const viewerActive = room.phase === "drafting" && (privateMode ? viewerOffer.length > 0 : room.activeSeat === viewer);
    const boardItems: Array<{ cardKey: string; position: number; offeredTo?: ArenaSeat }> =
      room.phase !== "drafting" && room.phase !== "loading"
        ? []
        : publicDraft
          ? room.boardKeys.map((cardKey, position) => ({ cardKey, position }))
          : [
              ...viewerOffer.map((cardKey, position) => ({ cardKey, position, offeredTo: viewer })),
              ...(room.settings.mode === "triple"
                ? room.currentOffers[otherSeat(viewer)].map((cardKey, position) => ({ cardKey, position, offeredTo: otherSeat(viewer) }))
                : []),
            ];
    const board: ArenaCell[] = boardItems.map(({ cardKey, position, offeredTo }) => {
      const selected = room.selected[cardKey];
      const offeredSeat = offeredTo ?? viewer;
      const groupedRoundKind = room.settings.mode === "triple" && room.settings.groupedSpecialRounds
        ? isMirrorRoom(room)
          ? mirrorRoundSchedule(room)[room.events.length]
          : groupedTripleSchedule[seatPickCount(room, offeredSeat)]
        : undefined;
      const offeredCard = cards.get(cardKey);
      const displayForm = groupedRoundKind && offeredCard
        ? isMirrorRoom(room)
          ? mirrorLockedFormForRound(room, offeredCard, groupedRoundKind)
          : lockedFormForRound(offeredCard, groupedRoundKind)
        : null;
      let legalForms: ArenaForm[] = [];
      const ownOffer = offeredTo === undefined || offeredTo === viewer;
      if (ownOffer && (viewerActive || room.phase === "loading") && !selected) {
        legalForms =
          isMirrorRoom(room)
            ? legalMirrorForms(room, cardKey)
            : room.settings.mode === "mega"
            ? legalMegaForms(room, viewer, cardKey)
            : room.settings.mode === "triple"
              ? legalTripleForms(room, viewer, cardKey)
              : classicDirection(room, viewer, cardKey, viewerOffer.find((key) => key !== cardKey) as string).selectedForms;
      }
      return {
        cardKey,
        position,
        ...(offeredTo ? { offeredTo } : {}),
        selectedBy: selected?.seat ?? null,
        ...(selected ? { selectedForm: selected.form } : {}),
        ...(displayForm ? { displayForm } : {}),
        legalForms,
      };
    });
    const participants = seats.flatMap((seat) => {
      const participant = room.participants[seat];
      if (!participant) return [];
      const visibleDeck = !privateMode
        ? room.decks[seat]
        : seat === viewer
          ? room.settings.mode === "triple" || room.phase === "complete"
            ? room.decks[seat]
            : room.decks[seat].filter((entry) => entry.pickedBy === viewer)
          : room.settings.mode === "classic"
            ? room.decks[seat].filter((entry) => entry.pickedBy === viewer)
            : [];
      return [{
        seat,
        name: participant.name,
        ready: participant.ready,
        loaded: participant.loaded,
        connected: participant.bot || connected(room.id, seat),
        bot: participant.bot,
        deck: clone(visibleDeck),
        deckCount: privateMode ? room.decks[seat].length : visibleDeck.length,
        collectionSource: participant.collection.source,
      }];
    });
    const result: ArenaView = {
      id: room.id,
      inviteCode: room.inviteCode,
      revision: room.revision,
      catalogVersion: room.catalogVersion,
      phase: room.phase,
      viewer,
      settings: clone(room.settings),
      participants,
      board,
      activeSeat: privateMode ? (room.phase === "drafting" && viewerOffer.length ? viewer : null) : room.activeSeat,
      pickNumber: room.phase === "loading" ? 0 : privateMode ? Math.min(room.settings.mode === "classic" ? 4 : 8, seatPickCount(room, viewer) + (viewerOffer.length ? 1 : 0)) : room.pickNumber,
      totalPicks: privateMode ? (room.settings.mode === "classic" ? 4 : 8) : room.totalPicks,
      startedAt: room.startedAt,
      interactiveAt: privateMode ? room.interactiveAtBySeat[viewer] : room.interactiveAt,
      deadlineAt: privateMode ? room.deadlineAtBySeat[viewer] : room.deadlineAt,
      serverNow: now(),
      events: clone(privateMode ? room.events.filter((event) => event.seat === viewer) : room.events),
      ...(room.settings.mode === "mega" && !isMirrorRoom(room) ? { megaStarter: room.megaStarter } : {}),
    };
    if (room.settings.mode === "triple" && room.settings.groupedSpecialRounds) {
      const roundSchedule = isMirrorRoom(room) ? mirrorRoundSchedule(room) : groupedTripleSchedule;
      result.roundSchedule = [...roundSchedule];
      const hasCurrentRound = isMirrorRoom(room) ? room.boardKeys.length > 0 && room.phase !== "complete" : room.currentOffers[viewer].length > 0;
      if (hasCurrentRound) {
        const roundIndex = isMirrorRoom(room) ? room.events.length : seatPickCount(room, viewer);
        const kind = roundSchedule[roundIndex];
        if (kind) {
          result.currentRound = {
            roundNumber: roundIndex + 1,
            totalRounds: roundSchedule.length,
            kind,
            remainingSpecialRounds: roundSchedule.slice(roundIndex).filter((round) => round !== "base").length,
          };
        }
      }
    }
    if (room.phase === "complete") {
      const issue = exportIssueForDeck(room.decks[viewer], cards, room.settings);
      if (issue) {
        result.exportError = issue;
      } else {
        const entries = safeExportEntries(room.decks[viewer]);
        const ids = entries.map((entry) => (cards.get(entry.cardKey) as ArenaCard).id);
        try {
          result.export = {
            url: buildClashRoyaleDeckLink(ids),
            entries: clone(entries),
            averageElixir: entries.every((entry) => isFixedArenaElixirCost((cards.get(entry.cardKey) as ArenaCard).elixir))
              ? entries.reduce((sum, entry) => sum + ((cards.get(entry.cardKey) as ArenaCard).elixir as number), 0) / deckSize
              : null,
          };
        } catch (error) {
          result.exportError = error instanceof Error ? error.message : "The completed deck could not be exported.";
        }
      }
    }
    return result;
  };

  // The social layer has already proven who owns an invited seat, so it may move that seat
  // onto the owner's current room token after their sign-in credential changes.
  const rebindInvitedSeat = (roomId: string, seat: ArenaSeat, tokenHash: string) => {
    ensureOpen();
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) throw new ArenaError(400, "Invited room token hashes must be SHA-256 hex strings", "INVALID_TOKEN_HASH");
    const changed = db.prepare("UPDATE arena_credentials SET token_hash = ? WHERE room_id = ? AND seat = ?").run(tokenHash, roomId, seat);
    if (changed.changes !== 1) throw new ArenaError(404, "Room not found", "ROOM_NOT_FOUND");
  };

  const getView = (roomId: string, token: string) => {
    ensureOpen();
    const seat = credentialSeat(roomId, token);
    return viewFor(loadRoom(roomId), seat);
  };

  const getRoomCatalog = (roomId: string, token: string): ArenaCatalogResponse => {
    ensureOpen();
    credentialSeat(roomId, token);
    const room = loadRoom(roomId);
    return { version: room.catalogVersion, updatedAt: room.catalogUpdatedAt, cards: clone(room.catalogCards) };
  };

  const broadcast = (roomId: string) => {
    const roomSubscribers = subscribers.get(roomId);
    if (!roomSubscribers) return;
    let room: InternalRoom;
    try {
      room = loadRoom(roomId);
    } catch {
      for (const seatSubscribers of roomSubscribers.values()) {
        for (const subscriber of seatSubscribers) {
          try {
            subscriber.close();
          } catch {
            // A disconnected transport cannot affect durable room state.
          }
        }
      }
      subscribers.delete(roomId);
      return;
    }
    for (const [seat, seatSubscribers] of roomSubscribers) {
      const view = viewFor(room, seat);
      for (const subscriber of seatSubscribers) {
        try {
          subscriber.send(view);
        } catch {
          seatSubscribers.delete(subscriber);
          try {
            subscriber.close();
          } catch {
            // The transport is already gone.
          }
        }
      }
    }
  };

  const recordCommand = (room: InternalRoom, seat: ArenaSeat, commandId: string, hash: string) => {
    db.prepare("INSERT INTO arena_commands(room_id, seat, command_id, payload_hash, result_revision, created_at) VALUES(?,?,?,?,?,?)").run(
      room.id,
      seat,
      commandId,
      hash,
      room.revision,
      now(),
    );
  };

  const existingCommand = (roomId: string, seat: ArenaSeat, commandId: string, hash: string) => {
    const row = db.prepare("SELECT payload_hash FROM arena_commands WHERE room_id = ? AND seat = ? AND command_id = ?").get(roomId, seat, commandId) as unknown as CommandRow | undefined;
    if (!row) return false;
    if (row.payload_hash !== hash) throw new ArenaError(409, "commandId was already used for a different command", "COMMAND_ID_REUSED");
    return true;
  };

  const touch = (room: InternalRoom) => {
    room.revision += 1;
    room.updatedAt = now();
    room.expiresAt = room.updatedAt + roomTtlMs;
  };

  const timerKey = (roomId: string, suffix: string) => `${roomId}:${suffix}`;

  const cancelTimers = (roomId: string) => {
    for (const [key, timer] of timers) {
      if (!key.startsWith(`${roomId}:`)) continue;
      clearTimeout(timer);
      timers.delete(key);
    }
  };

  const schedule = (room: InternalRoom) => {
    cancelTimers(room.id);
    if (closed) return;
    if (room.phase === "loading" && room.loadDeadlineAt !== null) {
      const timer = setTimeout(() => runLoadingTimeout(room.id), Math.max(0, room.loadDeadlineAt - now()));
      timer.unref?.();
      timers.set(timerKey(room.id, "a"), timer);
      return;
    }
    if (room.phase !== "drafting") return;
    const publicDraft = isPublicDraft(room);
    const scheduledSeats = publicDraft ? (room.activeSeat ? [room.activeSeat] : []) : seats.filter((seat) => room.currentOffers[seat].length > 0);
    if (room.settings.timerMode === "whole_draft" && room.wholeDraftDeadlineAt !== null) {
      const timer = setTimeout(
        () => runWholeDraftTimeout(room.id, room.wholeDraftDeadlineAt as number),
        Math.max(0, room.wholeDraftDeadlineAt - now()),
      );
      timer.unref?.();
      timers.set(timerKey(room.id, "whole"), timer);
    }
    for (const seat of scheduledSeats) {
      const interactiveAt = publicDraft ? room.interactiveAt : room.interactiveAtBySeat[seat];
      const deadlineAt = publicDraft ? room.deadlineAt : room.deadlineAtBySeat[seat];
      if (interactiveAt === null || deadlineAt === null) continue;
      const participant = room.participants[seat];
      if (room.settings.timerMode === "whole_draft" && !participant?.bot) continue;
      const fireAt = participant?.bot ? Math.min(deadlineAt, interactiveAt + botDelayMs) : deadlineAt;
      const delay = Math.max(0, Math.min(2_147_000_000, fireAt - now()));
      const expected = publicDraft ? room.revision : room.offerRevision[seat];
      const timer = setTimeout(() => runAutomatic(room.id, seat, expected), delay);
      timer.unref?.();
      timers.set(timerKey(room.id, seat), timer);
    }
  };

  const transactionalCommand = (
    roomId: string,
    token: string,
    commandIdValue: unknown,
    payload: unknown,
    mutate: (room: InternalRoom, seat: ArenaSeat) => void,
  ) => {
    ensureOpen();
    const seat = credentialSeat(roomId, token);
    const commandId = requireCommandId(commandIdValue);
    const hash = payloadHash(payload);
    db.exec("BEGIN IMMEDIATE");
    try {
      const room = loadRoom(roomId);
      if (existingCommand(roomId, seat, commandId, hash)) {
        db.exec("COMMIT");
        return { room, seat, duplicate: true };
      }
      mutate(room, seat);
      touch(room);
      saveRoom(room);
      recordCommand(room, seat, commandId, hash);
      db.exec("COMMIT");
      return { room, seat, duplicate: false };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const finishCommand = (result: { room: InternalRoom; seat: ArenaSeat }) => {
    schedule(result.room);
    broadcast(result.room.id);
    return viewFor(result.room, result.seat);
  };

  const pickAsSeat = (
    roomId: string,
    seat: ArenaSeat,
    cardKeyValue: unknown,
    formValue: unknown,
    commandIdValue: unknown,
    expectedRevisionValue: unknown,
    automatic: boolean,
    automaticAt?: number,
  ) => {
    const cardKey = requireString(cardKeyValue, "cardKey", 100);
    if (typeof formValue !== "string" || !forms.includes(formValue as ArenaForm)) throw new ArenaError(400, "A valid form is required", "INVALID_FORM");
    const form = formValue as ArenaForm;
    if (!Number.isInteger(expectedRevisionValue)) throw new ArenaError(400, "expectedRevision is required", "INVALID_REVISION");
    const commandId = requireCommandId(commandIdValue);
    const payload = { type: "pick", cardKey, form, expectedRevision: expectedRevisionValue, automatic };
    const hash = payloadHash(payload);
    db.exec("BEGIN IMMEDIATE");
    try {
      const room = loadRoom(roomId);
      if (existingCommand(roomId, seat, commandId, hash)) {
        db.exec("COMMIT");
        return { room, seat, duplicate: true };
      }
      const privateMode = !isPublicDraft(room);
      const expectedRevision = expectedRevisionValue as number;
      const revisionMatches = privateMode
        ? expectedRevision >= room.offerRevision[seat] && expectedRevision <= room.revision
        : room.revision === expectedRevision;
      if (!revisionMatches) throw new ArenaError(409, "Room revision changed", "REVISION_CONFLICT");
      if (room.phase !== "drafting" || (privateMode ? room.currentOffers[seat].length === 0 : room.activeSeat !== seat)) {
        throw new ArenaError(409, "This seat has no active pick", "OUT_OF_TURN");
      }
      const timestamp = automaticAt ?? now();
      const interactiveAt = privateMode ? room.interactiveAtBySeat[seat] : room.interactiveAt;
      const deadlineAt = privateMode ? room.deadlineAtBySeat[seat] : room.deadlineAt;
      if (!automatic && interactiveAt !== null && timestamp < interactiveAt) throw new ArenaError(409, "The next pick is not interactive yet", "PRESENTING_PICK");
      if (!automatic && deadlineAt !== null && timestamp >= deadlineAt) throw new ArenaError(409, "The pick deadline passed", "DEADLINE_PASSED");

      const offer = privateMode ? room.currentOffers[seat] : room.boardKeys;
      const position = offer.indexOf(cardKey);
      if (position < 0) throw new ArenaError(409, "Card is not in the current offer", "CARD_UNAVAILABLE");
      let legal: ArenaForm[];
      let received: ArenaPickEvent["received"];
      if (isMirrorRoom(room)) legal = legalMirrorForms(room, cardKey);
      else if (room.settings.mode === "mega") legal = legalMegaForms(room, seat, cardKey);
      else if (room.settings.mode === "triple") legal = legalTripleForms(room, seat, cardKey);
      else {
        const receivedKey = offer.find((key) => key !== cardKey);
        if (!receivedKey) throw new ArenaError(409, "Classic offer is incomplete", "INVALID_STATE");
        const direction = classicDirection(room, seat, cardKey, receivedKey);
        legal = direction.selectedForms;
        const receivedForm = direction.receivedBySelectedForm.get(form);
        if (receivedForm) {
          const opponent = otherSeat(seat);
          room.decks[opponent].push({ cardKey: receivedKey, form: receivedForm, pickedBy: seat, received: true });
          received = { seat: opponent, cardKey: receivedKey, form: receivedForm };
        }
      }
      if (!legal.includes(form)) throw new ArenaError(409, "Selected card form cannot preserve a legal completion", "ILLEGAL_PICK");
      const entry = { cardKey, form, pickedBy: seat } satisfies ArenaEntry;
      if (isMirrorRoom(room)) {
        room.decks.a.push({ ...entry });
        room.decks.b.push({ ...entry });
        if (room.settings.mode === "mega") room.selected[cardKey] = { seat, form };
      } else {
        room.decks[seat].push(entry);
        if (room.settings.mode === "mega") room.selected[cardKey] = { seat, form };
        else room.currentOffers[seat] = [];
      }
      touch(room);
      room.events.push({ revision: room.revision, seat, cardKey, form, position, at: timestamp, automatic, ...(received ? { received } : {}) });
      if (isMirrorRoom(room)) advanceMirror(room, timestamp, presentationDelayMs);
      else if (room.settings.mode === "mega") advanceMega(room, timestamp, presentationDelayMs);
      else advanceSeat(room, seat, timestamp, presentationDelayMs);
      saveRoom(room);
      recordCommand(room, seat, commandId, hash);
      db.exec("COMMIT");
      return { room, seat, duplicate: false };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const automaticChoice = (room: InternalRoom, seat: ArenaSeat) => {
    const keys = isPublicDraft(room)
      ? room.settings.mode === "mega"
        ? room.boardKeys.filter((key) => !room.selected[key])
        : room.boardKeys
      : room.currentOffers[seat];
    for (const cardKey of keys) {
      const legal =
        isMirrorRoom(room)
          ? legalMirrorForms(room, cardKey)
          : room.settings.mode === "mega"
          ? legalMegaForms(room, seat, cardKey)
          : room.settings.mode === "triple"
            ? legalTripleForms(room, seat, cardKey)
            : classicDirection(room, seat, cardKey, room.currentOffers[seat].find((key) => key !== cardKey) as string).selectedForms;
      if (legal.length) return { cardKey, form: legal[0] as ArenaForm };
    }
    return null;
  };

  function runAutomatic(roomId: string, seat: ArenaSeat, expectedRevision: number) {
    if (closed) return;
    let room: InternalRoom;
    try {
      room = loadRoom(roomId);
      const privateMode = !isPublicDraft(room);
      const stillCurrent = privateMode
        ? room.currentOffers[seat].length > 0 && room.offerRevision[seat] === expectedRevision
        : room.activeSeat === seat && room.revision === expectedRevision;
      if (room.phase !== "drafting" || !stillCurrent) {
        schedule(room);
        return;
      }
      const choice = automaticChoice(room, seat);
      if (!choice) throw new ArenaError(409, "No automatic legal pick exists", "NO_LEGAL_PICK");
      const result = pickAsSeat(roomId, seat, choice.cardKey, choice.form, `automatic:${room.round}:${seat}:${expectedRevision}`, room.revision, true);
      finishCommand(result);
    } catch (error) {
      if (!(error instanceof ArenaError && error.code === "REVISION_CONFLICT")) {
        // A later room command can make an elapsed callback stale; the next command reschedules it.
      }
    }
  }

  function runWholeDraftTimeout(roomId: string, expectedDeadline: number) {
    if (closed) return;
    const eventAt = now();
    let changed = false;
    try {
      for (let step = 0; step < 16; step += 1) {
        const room = loadRoom(roomId);
        if (room.phase !== "drafting" || room.settings.timerMode !== "whole_draft" || room.wholeDraftDeadlineAt !== expectedDeadline) break;
        if (eventAt < expectedDeadline) {
          schedule(room);
          return;
        }
        const seat = isPublicDraft(room)
          ? room.activeSeat
          : seats.find((candidate) => room.currentOffers[candidate].length > 0) ?? null;
        if (!seat) break;
        const choice = automaticChoice(room, seat);
        if (!choice) throw new ArenaError(409, "No automatic legal pick exists", "NO_LEGAL_PICK");
        const sequence = isPublicDraft(room) ? room.events.length : seatPickCount(room, seat);
        pickAsSeat(
          roomId,
          seat,
          choice.cardKey,
          choice.form,
          `whole-timeout:${room.round}:${seat}:${sequence}`,
          room.revision,
          true,
          eventAt,
        );
        changed = true;
      }
    } catch {
      // Feasibility checks should make this unreachable; committed picks remain durable and retryable.
    } finally {
      try {
        const room = loadRoom(roomId);
        schedule(room);
        if (changed) broadcast(roomId);
      } catch {
        // Room expiry or shutdown after a bounded fill needs no follow-up.
      }
    }
  }

  function runLoadingTimeout(roomId: string) {
    if (closed) return;
    let changed: InternalRoom | null = null;
    db.exec("BEGIN IMMEDIATE");
    try {
      const room = loadRoom(roomId);
      if (room.phase !== "loading") {
        db.exec("COMMIT");
        schedule(room);
        return;
      }
      if (room.loadDeadlineAt !== null && room.loadDeadlineAt > now()) {
        db.exec("COMMIT");
        schedule(room);
        return;
      }
      room.round += 1;
      room.phase = "waiting";
      room.decks = { a: [], b: [] };
      room.boardKeys = [];
      room.selected = {};
      room.remainingPool = [];
      room.currentOffers = { a: [], b: [] };
      room.offerQueues = { a: [], b: [] };
      room.sharedOfferQueue = [];
      room.offerRevision = { a: 0, b: 0 };
      room.activeSeat = null;
      room.pickNumber = 0;
      room.startedAt = null;
      room.interactiveAt = null;
      room.deadlineAt = null;
      room.interactiveAtBySeat = { a: null, b: null };
      room.deadlineAtBySeat = { a: null, b: null };
      room.wholeDraftDeadlineAt = null;
      room.loadDeadlineAt = null;
      room.events = [];
      for (const participant of Object.values(room.participants)) {
        if (!participant) continue;
        participant.ready = participant.bot;
        participant.loaded = participant.bot;
      }
      touch(room);
      saveRoom(room);
      db.exec("COMMIT");
      changed = room;
    } catch (error) {
      db.exec("ROLLBACK");
      if (!(error instanceof ArenaError && (error.code === "ROOM_NOT_FOUND" || error.code === "ROOM_EXPIRED"))) throw error;
    }
    if (changed) {
      schedule(changed);
      broadcast(changed.id);
    }
  }

  const makeToken = () => Buffer.from(random(32)).toString("base64url");
  const makeInvite = () => Buffer.from(random(6)).toString("base64url").replace(/[-_]/g, "").slice(0, 8).toUpperCase();
  const allocateInviteCode = () => {
    for (let attempts = 0; attempts < 10; attempts += 1) {
      const candidate = makeInvite();
      const exists = db.prepare("SELECT 1 AS found FROM arena_rooms WHERE invite_code = ?").get(candidate);
      if (!exists && candidate.length >= 6) return candidate;
    }
    throw new ArenaError(503, "Could not allocate an invite code", "INVITE_UNAVAILABLE");
  };

  const normalizeSettings = (input: unknown) => {
    ensureOpen();
    return sanitizeSettings(input, DEFAULT_ARENA_SETTINGS, currentCatalog);
  };

  const normalizeCollection = (input: unknown) => {
    ensureOpen();
    return sanitizeCollection(input, catalogKeys);
  };

  const createInvitedRoom = (input: CreateInvitedRoomInput): CreateInvitedRoomResult => {
    ensureOpen();
    const operationId = requireString(input.operationId, "operationId", 100);
    const settings = sanitizeSettings(input.settings, DEFAULT_ARENA_SETTINGS, currentCatalog);
    const host = {
      name: requireString(input.host?.name, "host name", 32),
      collection: sanitizeCollection(input.host?.collection, catalogKeys),
      tokenHash: requireString(input.host?.tokenHash, "host tokenHash", 64),
    };
    const guest = {
      name: requireString(input.guest?.name, "guest name", 32),
      collection: sanitizeCollection(input.guest?.collection, catalogKeys),
      tokenHash: requireString(input.guest?.tokenHash, "guest tokenHash", 64),
    };
    if (!/^[a-f0-9]{64}$/.test(host.tokenHash) || !/^[a-f0-9]{64}$/.test(guest.tokenHash)) {
      throw new ArenaError(400, "Invited room token hashes must be 64 lowercase hexadecimal characters", "INVALID_TOKEN_HASH");
    }
    if (host.tokenHash === guest.tokenHash) throw new ArenaError(400, "Invited room seats require distinct token hashes", "INVALID_TOKEN_HASH");
    const pairKey = input.pairKey === undefined ? undefined : requireString(input.pairKey, "pairKey", 64);
    if (pairKey !== undefined && !/^[a-f0-9]{64}$/.test(pairKey)) throw new ArenaError(400, "pairKey must be a 64-character lowercase hexadecimal hash", "INVALID_PAIR_KEY");
    const normalizedPayload = { settings, host, guest, ...(pairKey ? { pairKey } : {}) };
    const hash = payloadHash(normalizedPayload);
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db.prepare("SELECT payload_hash, room_id FROM arena_invited_operations WHERE operation_id = ?").get(operationId) as unknown as InvitedOperationRow | undefined;
      if (existing) {
        if (existing.payload_hash !== hash) throw new ArenaError(409, "operationId was already used for a different invited room", "OPERATION_ID_REUSED");
        const room = loadRoom(existing.room_id);
        db.exec("COMMIT");
        return { roomId: room.id, hostRoom: viewFor(room, "a"), guestRoom: viewFor(room, "b") };
      }
      const timestamp = now();
      const id = randomUUID();
      const inviteCode = allocateInviteCode();
      const room: InternalRoom = {
        schema: 2,
        id,
        inviteCode,
        catalogVersion: options.catalogVersion,
        catalogUpdatedAt: currentCatalogUpdatedAt,
        catalogCards: clone(currentCatalog),
        seed: Buffer.from(random(16)).toString("hex"),
        round: 1,
        revision: 1,
        phase: "waiting",
        settings,
        practice: false,
        participants: {
          a: { seat: "a", name: host.name, ready: false, loaded: false, bot: false, collection: host.collection },
          b: { seat: "b", name: guest.name, ready: false, loaded: false, bot: false, collection: guest.collection },
        },
        decks: { a: [], b: [] },
        boardKeys: [],
        selected: {},
        remainingPool: [],
        currentOffers: { a: [], b: [] },
        offerQueues: { a: [], b: [] },
        sharedOfferQueue: [],
        offerRevision: { a: 0, b: 0 },
        megaStarter: null,
        ...(pairKey ? { megaPairKey: pairKey } : {}),
        activeSeat: null,
        pickNumber: 0,
        totalPicks: totalPicksFor(settings),
        startedAt: null,
        interactiveAt: null,
        deadlineAt: null,
        interactiveAtBySeat: { a: null, b: null },
        deadlineAtBySeat: { a: null, b: null },
        wholeDraftDeadlineAt: null,
        loadDeadlineAt: null,
        events: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        expiresAt: timestamp + roomTtlMs,
      };
      db.prepare("INSERT INTO arena_rooms(id, invite_code, state_json, updated_at, expires_at) VALUES(?,?,?,?,?)").run(
        id,
        inviteCode,
        JSON.stringify(room),
        timestamp,
        room.expiresAt,
      );
      db.prepare("INSERT INTO arena_credentials(room_id, seat, token_hash, created_at) VALUES(?,?,?,?)").run(id, "a", host.tokenHash, timestamp);
      db.prepare("INSERT INTO arena_credentials(room_id, seat, token_hash, created_at) VALUES(?,?,?,?)").run(id, "b", guest.tokenHash, timestamp);
      db.prepare("INSERT INTO arena_invited_operations(operation_id, payload_hash, room_id, created_at) VALUES(?,?,?,?)").run(operationId, hash, id, timestamp);
      db.exec("COMMIT");
      return { roomId: id, hostRoom: viewFor(room, "a"), guestRoom: viewFor(room, "b") };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const createRoom = (input: CreateRoomInput): ArenaSessionResponse => {
    ensureOpen();
    const name = requireString(input.name, "name", 32);
    const settings = sanitizeSettings(input.settings, DEFAULT_ARENA_SETTINGS, currentCatalog);
    const practice = input.practice === undefined ? false : input.practice;
    if (typeof practice !== "boolean") throw new ArenaError(400, "practice must be boolean", "INVALID_INPUT");
    const collection = sanitizeCollection(input.collection, catalogKeys);
    const timestamp = now();
    const id = randomUUID();
    const token = makeToken();
    const inviteCode = allocateInviteCode();
    const room: InternalRoom = {
      schema: 2,
      id,
      inviteCode,
      catalogVersion: options.catalogVersion,
      catalogUpdatedAt: currentCatalogUpdatedAt,
      catalogCards: clone(currentCatalog),
      seed: Buffer.from(random(16)).toString("hex"),
      round: 1,
      revision: 1,
      phase: "waiting",
      settings,
      practice,
      participants: {
        a: { seat: "a", name, ready: false, loaded: false, bot: false, collection },
        ...(practice ? { b: { seat: "b" as const, name: "Practice Bot", ready: true, loaded: true, bot: true, collection: defaultCollection() } } : {}),
      },
      decks: { a: [], b: [] },
      boardKeys: [],
      selected: {},
      remainingPool: [],
      currentOffers: { a: [], b: [] },
      offerQueues: { a: [], b: [] },
      sharedOfferQueue: [],
      offerRevision: { a: 0, b: 0 },
      megaStarter: null,
      activeSeat: null,
      pickNumber: 0,
      totalPicks: totalPicksFor(settings),
      startedAt: null,
      interactiveAt: null,
      deadlineAt: null,
      interactiveAtBySeat: { a: null, b: null },
      deadlineAtBySeat: { a: null, b: null },
      wholeDraftDeadlineAt: null,
      loadDeadlineAt: null,
      events: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: timestamp + roomTtlMs,
    };
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO arena_rooms(id, invite_code, state_json, updated_at, expires_at) VALUES(?,?,?,?,?)").run(
        id,
        inviteCode,
        JSON.stringify(room),
        timestamp,
        room.expiresAt,
      );
      db.prepare("INSERT INTO arena_credentials(room_id, seat, token_hash, created_at) VALUES(?,?,?,?)").run(id, "a", sha256(token), timestamp);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { credential: { roomId: id, seat: "a", token }, room: viewFor(room, "a") };
  };

  const joinRoom = (input: JoinRoomInput): ArenaSessionResponse => {
    ensureOpen();
    const inviteCode = normalizeCode(input.inviteCode);
    const name = requireString(input.name, "name", 32);
    const token = makeToken();
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare("SELECT state_json FROM arena_rooms WHERE invite_code = ?").get(inviteCode) as unknown as RoomRow | undefined;
      if (!row) throw new ArenaError(404, "Invite code not found", "INVITE_NOT_FOUND");
      const room = decodeRoom(row.state_json);
      if (room.expiresAt <= now()) throw new ArenaError(410, "Room expired", "ROOM_EXPIRED");
      if (room.practice) throw new ArenaError(409, "Practice rooms already have an opponent", "ROOM_FULL");
      if (room.phase !== "waiting" || room.participants.b) throw new ArenaError(409, "Room is full or already started", "ROOM_FULL");
      const collection = sanitizeCollection(input.collection, new Set(room.catalogCards.map((card) => card.key)));
      room.participants.b = { seat: "b", name, ready: false, loaded: false, bot: false, collection };
      touch(room);
      saveRoom(room);
      db.prepare("INSERT INTO arena_credentials(room_id, seat, token_hash, created_at) VALUES(?,?,?,?)").run(room.id, "b", sha256(token), now());
      db.exec("COMMIT");
      broadcast(room.id);
      return { credential: { roomId: room.id, seat: "b", token }, room: viewFor(room, "b") };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const setReady = (roomId: string, token: string, input: { ready: unknown; commandId: unknown }) => {
    if (typeof input.ready !== "boolean") throw new ArenaError(400, "ready must be boolean", "INVALID_INPUT");
    const result = transactionalCommand(roomId, token, input.commandId, { type: "ready", ready: input.ready }, (room, seat) => {
      if (room.phase !== "waiting") throw new ArenaError(409, "Ready state can only change while waiting", "INVALID_PHASE");
      const participant = room.participants[seat];
      if (!participant || participant.bot) throw new ArenaError(403, "This seat cannot change ready state", "FORBIDDEN");
      participant.ready = input.ready as boolean;
      participant.loaded = false;
      if (room.participants.a?.ready && room.participants.b?.ready) {
        // Canonicalize old waiting-room settings immediately before a new deal.
        // Active boards remain untouched; rematches use the same normalization.
        room.settings = sanitizeSettings(room.settings, DEFAULT_ARENA_SETTINGS, room.catalogCards);
        prepareDraft(room, now(), loadingTimeoutMs);
      }
    });
    return finishCommand(result);
  };

  const setLoaded = (roomId: string, token: string, input: { commandId: unknown }) => {
    ensureOpen();
    credentialSeat(roomId, token);
    const existing = loadRoom(roomId);
    if (existing.phase === "loading" && existing.loadDeadlineAt !== null && existing.loadDeadlineAt <= now()) {
      runLoadingTimeout(roomId);
      throw new ArenaError(409, "Asset loading window expired; ready again to retry", "LOADING_EXPIRED");
    }
    const result = transactionalCommand(roomId, token, input.commandId, { type: "loaded" }, (room, seat) => {
      if (room.phase !== "loading") throw new ArenaError(409, "The room is not preparing assets", "INVALID_PHASE");
      const participant = room.participants[seat];
      if (!participant || participant.bot) throw new ArenaError(403, "This seat cannot acknowledge loading", "FORBIDDEN");
      participant.loaded = true;
      if (room.participants.a?.loaded && room.participants.b?.loaded) {
        commitMegaStarter(room);
        activatePreparedDraft(room, now(), initialDealMsFor(room.settings.mode));
      }
    });
    return finishCommand(result);
  };

  const pick = (roomId: string, token: string, input: { cardKey: unknown; form: unknown; commandId: unknown; expectedRevision: unknown }) => {
    ensureOpen();
    const seat = credentialSeat(roomId, token);
    const existingRoom = loadRoom(roomId);
    const commandId = requireCommandId(input.commandId);
    const commandPayload = { type: "pick", cardKey: input.cardKey, form: input.form, expectedRevision: input.expectedRevision, automatic: false };
    const publicDraft = isPublicDraft(existingRoom);
    const deadlineAt = publicDraft ? existingRoom.deadlineAt : existingRoom.deadlineAtBySeat[seat];
    const expected = publicDraft ? existingRoom.revision : existingRoom.offerRevision[seat];
    if (!existingCommand(roomId, seat, commandId, payloadHash(commandPayload)) && existingRoom.phase === "drafting" && deadlineAt !== null && now() >= deadlineAt) {
      if (existingRoom.settings.timerMode === "whole_draft" && existingRoom.wholeDraftDeadlineAt !== null) {
        runWholeDraftTimeout(roomId, existingRoom.wholeDraftDeadlineAt);
      } else {
        runAutomatic(roomId, publicDraft ? existingRoom.activeSeat ?? seat : seat, expected);
      }
      throw new ArenaError(409, "The pick deadline passed and an automatic pick was committed", "DEADLINE_PASSED");
    }
    return finishCommand(pickAsSeat(roomId, seat, input.cardKey, input.form, commandId, input.expectedRevision, false));
  };

  const setCollection = (roomId: string, token: string, input: { collection: unknown; commandId: unknown }) => {
    const result = transactionalCommand(roomId, token, input.commandId, { type: "collection", collection: input.collection }, (room, seat) => {
      if (room.phase !== "waiting") throw new ArenaError(409, "Collection can only change while waiting", "INVALID_PHASE");
      const participant = room.participants[seat];
      if (!participant || participant.bot) throw new ArenaError(403, "This seat cannot change collection", "FORBIDDEN");
      participant.collection = sanitizeCollection(input.collection, new Set(room.catalogCards.map((card) => card.key)));
      participant.ready = false;
      participant.loaded = false;
    });
    return finishCommand(result);
  };

  const setSettings = (roomId: string, token: string, input: { settings: unknown; commandId: unknown }) => {
    const result = transactionalCommand(roomId, token, input.commandId, { type: "settings", settings: input.settings }, (room, seat) => {
      if (seat !== "a") throw new ArenaError(403, "Only the host can change settings", "FORBIDDEN");
      if (room.phase !== "waiting") throw new ArenaError(409, "Settings can only change while waiting", "INVALID_PHASE");
      room.settings = sanitizeSettings(input.settings, room.settings, room.catalogCards);
      for (const participant of Object.values(room.participants)) {
        if (!participant || participant.bot) continue;
        participant.ready = false;
        participant.loaded = false;
      }
      room.totalPicks = totalPicksFor(room.settings);
    });
    return finishCommand(result);
  };

  const rematch = (roomId: string, token: string, input: { commandId: unknown }) => {
    const result = transactionalCommand(roomId, token, input.commandId, { type: "rematch" }, (room, seat) => {
      if (seat !== "a") throw new ArenaError(403, "Only the host can start a rematch", "FORBIDDEN");
      if (room.phase !== "complete") throw new ArenaError(409, "Rematch is available after the draft completes", "INVALID_PHASE");
      room.settings = sanitizeSettings(room.settings, DEFAULT_ARENA_SETTINGS, room.catalogCards);
      room.round += 1;
      // The completed starter, not host status, determines the rematch opener.
      // It is committed to a pair cursor only after both seats load again.
      room.megaStarter = room.settings.mode === "mega" && !isMirrorRoom(room)
        ? otherSeat(room.megaStarter ?? "a")
        : null;
      room.phase = "waiting";
      room.decks = { a: [], b: [] };
      room.boardKeys = [];
      room.selected = {};
      room.remainingPool = [];
      room.currentOffers = { a: [], b: [] };
      room.offerQueues = { a: [], b: [] };
      room.sharedOfferQueue = [];
      room.offerRevision = { a: 0, b: 0 };
      room.activeSeat = null;
      room.pickNumber = 0;
      room.totalPicks = totalPicksFor(room.settings);
      room.startedAt = null;
      room.interactiveAt = null;
      room.deadlineAt = null;
      room.interactiveAtBySeat = { a: null, b: null };
      room.deadlineAtBySeat = { a: null, b: null };
      room.wholeDraftDeadlineAt = null;
      room.loadDeadlineAt = null;
      room.events = [];
      for (const participant of Object.values(room.participants)) {
        if (!participant) continue;
        participant.ready = participant.bot;
        participant.loaded = participant.bot;
      }
    });
    return finishCommand(result);
  };

  const subscribe = (roomId: string, token: string, send: (view: ArenaView) => void, closeSubscriber: () => void) => {
    ensureOpen();
    const seat = credentialSeat(roomId, token);
    const room = loadRoom(roomId);
    let bySeat = subscribers.get(roomId);
    if (!bySeat) {
      bySeat = new Map();
      subscribers.set(roomId, bySeat);
    }
    let seatSubscribers = bySeat.get(seat);
    if (!seatSubscribers) {
      seatSubscribers = new Set();
      bySeat.set(seat, seatSubscribers);
    }
    const subscriber = { send, close: closeSubscriber };
    seatSubscribers.add(subscriber);
    send(viewFor(room, seat));
    broadcast(roomId);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      seatSubscribers?.delete(subscriber);
      if (seatSubscribers?.size === 0) bySeat?.delete(seat);
      if (bySeat?.size === 0) subscribers.delete(roomId);
      else broadcast(roomId);
    };
  };

  const close = () => {
    if (closed) return;
    closed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const roomSubscribers of subscribers.values()) {
      for (const seatSubscribers of roomSubscribers.values()) {
        for (const subscriber of seatSubscribers) {
          try {
            subscriber.close();
          } catch {
            // Closing one transport must not prevent database shutdown.
          }
        }
      }
    }
    subscribers.clear();
    db.close();
  };

  // Resume every unexpired drafting room from its persisted deadline.
  const draftingRows = db.prepare("SELECT state_json FROM arena_rooms WHERE expires_at > ?").all(now()) as unknown as RoomRow[];
  for (const row of draftingRows) {
    try {
      const room = decodeRoom(row.state_json);
      if (room.phase === "drafting" || room.phase === "loading") schedule(room);
    } catch {
      // One damaged local room must not prevent healthy rooms from resuming.
    }
  }

  return {
    catalog: { version: options.catalogVersion, updatedAt: currentCatalogUpdatedAt, cards: clone(currentCatalog) },
    normalizeSettings,
    normalizeCollection,
    createInvitedRoom,
    rebindInvitedSeat,
    createRoom,
    joinRoom,
    getRoomCatalog,
    getView,
    setReady,
    setLoaded,
    pick,
    setCollection,
    setSettings,
    rematch,
    subscribe,
    close,
  };
};
