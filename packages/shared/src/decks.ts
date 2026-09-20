import type { ArenaCard, ArenaForm } from "./arena.js";

export type DeckMode = "2v2" | "classic" | "chaos" | "mirror" | "custom";
export type DeckVisibility = "private" | "public";

export interface DeckSource {
  kind: "video" | "supercell" | "royaleapi" | "community" | "local";
  label: string;
  url?: string;
  sourceId?: string;
  timestampSeconds?: number;
  confidence?: "verified" | "high" | "medium" | "low";
}

export interface DeckDefinition {
  id: string;
  name: string;
  mode: DeckMode;
  /** Exact eight-card export order. */
  cards: string[];
  /** Missing keys use the base form. */
  forms?: Partial<Record<string, ArenaForm>>;
  description?: string;
  tags?: string[];
  source: DeckSource;
  visibility?: DeckVisibility;
  ownerId?: string;
  author?: string;
  updatedAt?: string;
}

export interface DeckPair {
  id: string;
  name: string;
  mode: "2v2";
  decks: [DeckDefinition, DeckDefinition];
  description?: string;
  tags?: string[];
  source: DeckSource;
}

export interface DeckCollection {
  id: string;
  title: string;
  mode: DeckMode;
  description?: string;
  decks?: DeckDefinition[];
  pairs?: DeckPair[];
}

export interface DeckSeedResponse {
  version: 1;
  generatedAt: string;
  collections: DeckCollection[];
}

export interface DeckValidationResult {
  valid: boolean;
  errors: string[];
  averageElixir: number | null;
}

export const formForDeckCard = (deck: Pick<DeckDefinition, "forms">, cardKey: string): ArenaForm =>
  deck.forms?.[cardKey] ?? "base";

export function validateDeck(deck: Pick<DeckDefinition, "cards" | "forms">, catalog: readonly ArenaCard[]): DeckValidationResult {
  const errors: string[] = [];
  const cardsByKey = new Map(catalog.map((card) => [card.key, card]));
  if (deck.cards.length !== 8) errors.push(`Choose exactly 8 cards (${deck.cards.length}/8).`);
  if (new Set(deck.cards).size !== deck.cards.length) errors.push("Each card can appear only once.");

  let elixir = 0;
  let knownCards = 0;
  let evolutions = 0;
  let heroChampions = 0;
  let champions = 0;
  let specialForms = 0;
  for (const cardKey of deck.cards) {
    const card = cardsByKey.get(cardKey);
    if (!card) {
      errors.push(`Unknown card: ${cardKey}.`);
      continue;
    }
    knownCards += 1;
    elixir += card.elixir;
    const form = formForDeckCard(deck, cardKey);
    if (!card.forms.some((candidate) => candidate.key === form)) {
      errors.push(`${card.name} does not support the ${form} form.`);
      continue;
    }
    if (form !== "base") specialForms += 1;
    if (form === "evolution") evolutions += 1;
    if (form === "hero" || form === "champion") heroChampions += 1;
    if (form === "champion") champions += 1;
  }
  if (evolutions > 2) errors.push("A deck can use at most two Evolution forms.");
  if (heroChampions > 2) errors.push("A deck can use at most two Hero or Champion forms.");
  if (champions > 1) errors.push("A deck can use at most one Champion form.");
  if (specialForms > 3) errors.push("A deck has three special-form slots.");

  return {
    valid: errors.length === 0,
    errors,
    averageElixir: knownCards === deck.cards.length && knownCards > 0 ? elixir / knownCards : null,
  };
}
