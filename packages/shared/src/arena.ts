import { isChaosBattleMode, isChaosInfiniteElixirBattleMode, isChaosInfiniteElixirSupportedCard, isChaosModifierCard } from "./chaos.js";

/** Public, viewer-specific contract for the rebuilt drafting experience. */
export type ArenaSeat = "a" | "b";
export type ArenaMode = "mega" | "triple" | "classic";
export type ArenaForm = "base" | "evolution" | "hero" | "champion";
export type ArenaRoundKind = "evolution" | "hero_champion" | "base";
export const ARENA_MEGA_MIN_POOL_SIZE = 16;
export const ARENA_MEGA_MAX_POOL_SIZE = 36;
export const ARENA_MIRROR_CARD_KEY = "mirror";
/** New non-Chaos Mirror drafts include Mirror, then accept seven shared picks. */
export const ARENA_MIRROR_PICK_COUNT = 7;

export interface ArenaCard {
  key: string;
  id: number;
  name: string;
  elixir: number;
  rarity: string;
  kind: string;
  families: string[];
  forms: { key: ArenaForm; label: string; asset: string }[];
}
export interface ArenaElixirRange { min: number; max: number }

export interface ArenaSettings {
  mode: ArenaMode;
  /** Mega board upper cap (16–36); actual board may shrink with card filters. */
  poolSize: number;
  pickSeconds: number;
  timerMode?: "per_pick" | "whole_draft";
  specialForms: boolean;
  /** Triple-only locked-form waves; normalized off for other modes or base-only drafts. */
  groupedSpecialRounds?: boolean;
  /** Shared public draft: alternating picks create one identical deck for both seats. */
  mirrorMode?: boolean;
  battleMode: string;
  minElixir?: number;
  maxElixir?: number;
  /** Inclusive ranges combined with OR. An explicit empty list allows every cost. */
  elixirRanges?: ArenaElixirRange[];
  includeCards?: string[];
  excludeCards?: string[];
  /** Cards manually restored after semantic filters. Values are Clash card ids. */
  includedCardIds?: number[];
  /** Cards manually removed after semantic filters. Values are Clash card ids. */
  excludedCardIds?: number[];
  cardKinds?: string[];
  rarities?: string[];
  families?: string[];
}
/** null = unrestricted, user-declared availability; never presented as API verified. */
export interface ArenaCollection {
  cards: string[] | null;
  forms: Record<string, ArenaForm[]> | null;
  source: "unrestricted" | "manual" | "api";
}
export interface ArenaEntry {
  cardKey: string;
  form: ArenaForm;
  pickedBy: ArenaSeat;
  received?: boolean;
  /** Server-included deck card; it has no corresponding pick event. */
  preset?: boolean;
}
export interface ArenaCell {
  cardKey: string;
  position: number;
  /** Present for private-mode offers so simultaneous lanes can be rendered separately. */
  offeredTo?: ArenaSeat;
  selectedBy: ArenaSeat | null;
  selectedForm?: ArenaForm;
  /** Public art form for a locked grouped offer; does not grant pick rights. */
  displayForm?: ArenaForm;
  legalForms: ArenaForm[];
}
export interface ArenaRoundMetadata {
  roundNumber: number;
  totalRounds: number;
  kind: ArenaRoundKind;
  /** Includes the current round when it is a special round. */
  remainingSpecialRounds: number;
}
export interface ArenaPickEvent {
  revision: number;
  seat: ArenaSeat;
  cardKey: string;
  form: ArenaForm;
  position: number;
  at: number;
  automatic: boolean;
  received?: { seat: ArenaSeat; cardKey: string; form: ArenaForm };
}
export interface ArenaParticipant {
  seat: ArenaSeat;
  name: string;
  ready: boolean;
  loaded: boolean;
  connected: boolean;
  bot: boolean;
  deck: ArenaEntry[];
  deckCount: number;
  collectionSource: ArenaCollection["source"];
}
export interface ArenaView {
  id: string;
  inviteCode: string;
  revision: number;
  catalogVersion: string;
  phase: "waiting" | "loading" | "drafting" | "complete";
  viewer: ArenaSeat;
  settings: ArenaSettings;
  participants: ArenaParticipant[];
  /** Stable grid for Mega; viewer-visible offers for private modes, partitioned by offeredTo. */
  board: ArenaCell[];
  activeSeat: ArenaSeat | null;
  pickNumber: number;
  totalPicks: number;
  startedAt: number | null;
  interactiveAt: number | null;
  deadlineAt: number | null;
  serverNow: number;
  events: ArenaPickEvent[];
  roundSchedule?: ArenaRoundKind[];
  currentRound?: ArenaRoundMetadata;
  export?: { url: string; entries: ArenaEntry[]; averageElixir: number };
  /** Present instead of export when a preserved completed deck cannot produce a legal copy link. */
  exportError?: string;
}
export interface ArenaCredential {
  roomId: string;
  seat: ArenaSeat;
  token: string;
}
export interface ArenaSessionResponse {
  credential: ArenaCredential;
  room: ArenaView;
}
export interface ArenaCatalogResponse {
  version: string;
  updatedAt: string;
  cards: ArenaCard[];
}

export const DEFAULT_ARENA_SETTINGS: ArenaSettings = {
  mode: "mega", poolSize: 36, pickSeconds: 15,
  timerMode: "per_pick", specialForms: true, groupedSpecialRounds: false, mirrorMode: false, battleMode: "Friendly 1v1",
};

/** Chaos Mirror keeps eight normal picks because the Mirror card is unavailable there. */
export const shouldPresetMirrorCard = (settings: Pick<ArenaSettings, "mirrorMode" | "battleMode">): boolean =>
  settings.mirrorMode === true && !isChaosBattleMode(settings.battleMode);

export const isArenaElixirRanges = (value: unknown): value is ArenaElixirRange[] => Array.isArray(value)
  && value.length <= 32
  && value.every((range: unknown) => {
    if (!range || typeof range !== "object") return false;
    const { min, max } = range as ArenaElixirRange;
    return typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max)
      && min >= 0 && max <= 10 && min <= max;
  });

/** Older single-range setups remain usable without a data migration. */
export const arenaElixirRanges = (settings: Pick<ArenaSettings, "elixirRanges" | "minElixir" | "maxElixir">): ArenaElixirRange[] =>
  settings.elixirRanges ?? (settings.minElixir !== undefined || settings.maxElixir !== undefined
    ? [{ min: settings.minElixir ?? 0, max: settings.maxElixir ?? 10 }] : []);

/** Mode invariants that a manual pool edit may never bypass. */
export const isArenaCardHardEligible = (card: ArenaCard, settings: ArenaSettings): boolean => {
  const infiniteElixir = isChaosInfiniteElixirBattleMode(settings.battleMode);
  const otherChaos = !infiniteElixir && isChaosBattleMode(settings.battleMode);
  return (!shouldPresetMirrorCard(settings) || card.key !== ARENA_MIRROR_CARD_KEY)
    && (!infiniteElixir || isChaosInfiniteElixirSupportedCard(card))
    && (!otherChaos || isChaosModifierCard(card))
    && (settings.specialForms || card.forms.some((form) => form.key === "base"));
};

/** Applies hard mode rules plus the normal semantic filters, before manual pool edits. */
export const filterArenaCardsBeforeOverrides = (cards: readonly ArenaCard[], settings: ArenaSettings): ArenaCard[] => {
  const includeCards = settings.includeCards === undefined ? null : new Set(settings.includeCards);
  const excludeCards = new Set(settings.excludeCards ?? []);
  const cardKinds = settings.cardKinds?.length ? new Set(settings.cardKinds) : null;
  const rarities = settings.rarities?.length ? new Set(settings.rarities) : null;
  const families = settings.families?.length ? new Set(settings.families) : null;
  const elixirRanges = arenaElixirRanges(settings);
  return cards.filter((card) =>
    isArenaCardHardEligible(card, settings) &&
    (includeCards === null || includeCards.has(card.key)) &&
    !excludeCards.has(card.key) &&
    (!elixirRanges.length || elixirRanges.some(({ min, max }) => card.elixir >= min && card.elixir <= max)) &&
    (cardKinds === null || cardKinds.has(card.kind)) &&
    (rarities === null || rarities.has(card.rarity)) &&
    (families === null || card.families.some((family) => families.has(family)))
  );
};

/** Applies normal filters, then manual additions/removals, while retaining hard mode legality. */
export const filterArenaCards = (cards: readonly ArenaCard[], settings: ArenaSettings): ArenaCard[] => {
  const filteredIds = new Set(filterArenaCardsBeforeOverrides(cards, settings).map((card) => card.id));
  const includedIds = new Set(settings.includedCardIds ?? []);
  const excludedIds = new Set(settings.excludedCardIds ?? []);
  return cards.filter((card) =>
    isArenaCardHardEligible(card, settings)
    && (filteredIds.has(card.id) || includedIds.has(card.id))
    && !excludedIds.has(card.id)
  );
};

/** Resolves Mega's configured upper cap against the currently eligible catalog. */
export const effectiveMegaPoolSize = (settings: Pick<ArenaSettings, "poolSize">, eligibleCount: number): number => {
  const available = Number.isFinite(eligibleCount) ? Math.max(0, Math.floor(eligibleCount)) : 0;
  return Math.min(ARENA_MEGA_MAX_POOL_SIZE, settings.poolSize, available);
};
