/**
 * Current C.H.A.O.S Infinite Elixir base-card pool observed for the live mode.
 *
 * RoyaleTracker's mode-specific page reports a complete 51-card pool, no
 * Evolutions, and no Heroes. The exhaustive identity list also contains no
 * Champion identity, so this companion treats the mode as base-only. See the
 * reviewed source record in data/catalog/chaos-pool-2026-09-05.json.
 */
export const CHAOS_POOL_CHECKED_AT = "2026-09-06";
export const CHAOS_POOL_SOURCE = "https://royaletracker.gg/best-decks/chaos-infinite-elixir";
export const CHAOS_INFINITE_ELIXIR_CARD_IDS: Readonly<Record<string, number>> = Object.freeze({
  "royal-hogs": 26000059,
  "ronin": 26000106,
  "skeleton-barrel": 26000056,
  "graveyard": 28000010,
  "giant": 26000003,
  "the-log": 28000011,
  "fireball": 28000000,
  "tesla": 27000006,
  "rage": 28000002,
  "knight": 26000000,
  "skeleton-army": 26000012,
  "poison": 28000009,
  "rocket": 28000003,
  "barbarian-barrel": 28000015,
  "berserker": 26000102,
  "mortar": 27000002,
  "mega-knight": 26000055,
  "musketeer": 26000014,
  "suspicious-bush": 26000097,
  "lava-hound": 26000029,
  "pekka": 26000004,
  "royal-giant": 26000024,
  "firecracker": 26000064,
  "electro-wizard": 26000042,
  "ram-rider": 26000051,
  "wizard": 26000017,
  "executioner": 26000045,
  "x-bow": 27000008,
  "rascals": 26000053,
  "three-musketeers": 26000028,
  "princess": 26000026,
  "baby-dragon": 26000015,
  "inferno-dragon": 26000037,
  "night-witch": 26000048,
  "elixir-golem": 26000067,
  "arrows": 28000001,
  "inferno-tower": 27000003,
  "zap": 28000008,
  "electro-spirit": 26000084,
  "hunter": 26000044,
  "bandit": 26000046,
  "mother-witch": 26000083,
  "heal-spirit": 28000016,
  "valkyrie": 26000011,
  "rune-giant": 26000101,
  "witch": 26000007,
  "zappies": 26000052,
  "ice-wizard": 26000023,
  "dark-prince": 26000027,
  "elite-barbarians": 26000043,
  "dart-goblin": 26000040,
});

/** Wider modifier-bearing union for Chaos variants whose exact pools remain unpublished. */
export const CHAOS_MODIFIER_POOL_SOURCE = "https://royaleapi.com/cards/popular?cat=CHAOS_Mod&mode=grid&sort=rating&time=7d";
export const CHAOS_MODIFIER_CARD_IDS: Readonly<Record<string, number>> = Object.freeze({
  ...CHAOS_INFINITE_ELIXIR_CARD_IDS,
  "barbarian-hut": 27000005,
  "fisherman": 26000061,
  "flying-machine": 26000057,
  "furnace": 27000010,
  "giant-snowball": 28000017,
  "goblin-barrel": 28000004,
  "goblin-demolisher": 26000095,
  "goblin-drill": 27000013,
  "goblin-giant": 26000060,
  "goblin-hut": 27000001,
  "golem": 26000009,
  "ice-spirit": 26000030,
  "royal-delivery": 28000018,
  "tombstone": 27000009,
  "vines": 28000026,
});

/** Backward-compatible current Infinite Elixir exports. */
export const CHAOS_CARD_IDS = CHAOS_INFINITE_ELIXIR_CARD_IDS;
export const CHAOS_POOL_CARD_COUNT = Object.keys(CHAOS_INFINITE_ELIXIR_CARD_IDS).length;
export const CHAOS_MODIFIER_CARD_COUNT = Object.keys(CHAOS_MODIFIER_CARD_IDS).length;

const normalizeBattleMode = (battleMode: string) => battleMode.replace(/\./g, "").trim().replace(/\s+/g, " ").toLowerCase();

/** Includes the current label and the companion's intentional saved legacy alias. */
export const isChaosInfiniteElixirBattleMode = (battleMode: string): boolean => {
  const normalized = normalizeBattleMode(battleMode);
  return normalized === "chaos infinite elixir" || normalized === "chaos friendly battle";
};

/** Includes all Chaos labels; do not use this to infer the Infinite Elixir pool. */
export const isChaosBattleMode = (battleMode: string): boolean => /\bchaos\b/.test(normalizeBattleMode(battleMode));

export const isChaosInfiniteElixirSupportedCard = (card: { key: string; id: number }): boolean =>
  Object.hasOwn(CHAOS_INFINITE_ELIXIR_CARD_IDS, card.key) && CHAOS_INFINITE_ELIXIR_CARD_IDS[card.key] === card.id;

export const isChaosModifierCard = (card: { key: string; id: number }): boolean =>
  Object.hasOwn(CHAOS_MODIFIER_CARD_IDS, card.key) && CHAOS_MODIFIER_CARD_IDS[card.key] === card.id;

/** Backward-compatible current Infinite Elixir card check. */
export const isChaosSupportedCard = isChaosInfiniteElixirSupportedCard;
