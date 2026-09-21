import type { ArenaCard, ArenaForm, TrackerCard } from "@draft-royale/shared";

export type CatalogById = ReadonlyMap<number, ArenaCard>;
export interface ResolvedTrackerCard { tracked: TrackerCard; card: ArenaCard | null; form: ArenaForm }

export const catalogById = (catalog: readonly ArenaCard[]): CatalogById => new Map(catalog.map((card) => [card.id, card]));

// The catalog has no combined hero-evolution form; the evolution art is the closer match when it exists.
export const catalogForm = (card: ArenaCard, tracked: Pick<TrackerCard, "form">): ArenaForm => {
  const wanted: ArenaForm[] = tracked.form === "heroEvolution" ? ["evolution", "hero"] : tracked.form === "base" ? [] : [tracked.form];
  return wanted.find((form) => card.forms.some((candidate) => candidate.key === form)) ?? "base";
};

/** ArenaCard.id is the Clash card id, so a tracked card resolves by id alone; cards newer than the catalog resolve to null. */
export const resolveTrackerCard = (tracked: TrackerCard, cardsById: CatalogById): ResolvedTrackerCard => {
  const card = tracked.id === null ? null : cardsById.get(tracked.id) ?? null;
  return { tracked, card, form: card ? catalogForm(card, tracked) : "base" };
};

export const formBadge = (form: ArenaForm) => form === "evolution" ? "E" : form === "hero" ? "H" : form === "champion" ? "C" : "";
/** Champions exist in one form only, so only evolved and hero copies need telling apart from the base card. */
export const trackerCardLabel = (tracked: Pick<TrackerCard, "name" | "form">) => tracked.name + (tracked.form === "base" || tracked.form === "champion" ? "" : tracked.form === "heroEvolution" ? " (hero evolution)" : ` (${tracked.form})`);
/** The card-stats endpoint keys its cards by id, or by key when the API gave no id. */
export const cardStatKey = (card: { id: number | null; key: string }) => String(card.id ?? card.key);
