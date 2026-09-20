import type { ArenaCard } from "./arena.js";

// Base-form ranged troop identities derived from the checked-in RoyaleAPI stats:
// troop.summon_character / summon_character_second -> characters.range >= 2000.
// Jump-trigger distances on Spirits are excluded. This is a search aid, not a matchup score.
const rangedTroops = new Set([
  "archers",
  "witch",
  "bomber",
  "musketeer",
  "baby-dragon",
  "wizard",
  "spear-goblins",
  "ice-wizard",
  "royal-giant",
  "princess",
  "three-musketeers",
  "lava-hound",
  "sparky",
  "bowler",
  "inferno-dragon",
  "dart-goblin",
  "goblin-gang",
  "electro-wizard",
  "hunter",
  "executioner",
  "zappies",
  "rascals",
  "cannon-cart",
  "flying-machine",
  "magic-archer",
  "electro-dragon",
  "firecracker",
  "archer-queen",
  "skeleton-dragons",
  "mother-witch"
]);
export const isRangedArenaCard = (card: ArenaCard): boolean => rangedTroops.has(card.key);
export const isGroundArenaCard = (card: ArenaCard): boolean => card.kind === "troop" && !card.families.includes("flying");
