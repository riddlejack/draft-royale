import type { TrackerBattleResult, TrackerCard, TrackerDeckOrigin, TrackerTally } from "@draft-royale/shared";

// Tallies group a card across many battles, so a single battle's level would be misleading there.
export const bareCard = ({ id, key, name, form, elixirCost }: TrackerCard): TrackerCard => ({ id, key, name, form, elixirCost });
export const deckSignature = (cards: TrackerCard[]) => [...cards]
  .sort((left, right) => `${left.id ?? left.key}:${left.form}`.localeCompare(`${right.id ?? right.key}:${right.form}`))
  .map((card) => `${card.id ?? card.key}:${card.form}`).join("|");

const CHOSEN_DECK_SELECTIONS = new Set(["collection", "warDeckPick", "quadDeckPick"]);
/** Battles recorded before deckSelection was kept fall back to the mode name, which names mirror, draft and pick modes. */
export const deckOriginOf = (deckSelection: string | null | undefined, modeName: string): { origin: TrackerDeckOrigin; inferred: boolean } =>
  deckSelection
    ? { origin: CHOSEN_DECK_SELECTIONS.has(deckSelection) ? "chosen" : "assigned", inferred: false }
    : { origin: /mirror|draft|pickmode/i.test(modeName) ? "assigned" : "chosen", inferred: true };

export const emptyTally = (): TrackerTally => ({ games: 0, wins: 0, losses: 0, draws: 0, unknown: 0, winRate: null });
export const addResult = <T extends TrackerTally>(tally: T, result: TrackerBattleResult) => {
  tally.games += 1;
  if (result === "win") tally.wins += 1;
  else if (result === "loss") tally.losses += 1;
  else if (result === "draw") tally.draws += 1;
  else tally.unknown += 1;
};
export const finalizeTally = <T extends TrackerTally>(tally: T): T => {
  const decided = tally.wins + tally.losses + tally.draws;
  tally.winRate = decided > 0 ? tally.wins / decided : null;
  return tally;
};
