import type { ArenaCard, ArenaForm, DeckDefinition, DeckPair } from "@draft-royale/shared";
import { buildClashRoyaleDeckLink } from "@draft-royale/shared";
import { storage } from "../client";

const savedDecksKey = "saved-decks-v1";

export const readSavedDecks = (profileId?: string) => {
  const value = storage.get<unknown>(profileId ? `${savedDecksKey}:${profileId}` : savedDecksKey, []);
  return Array.isArray(value) ? value.filter(isDeckDefinition) : [];
};
export const writeSavedDecks = (decks: readonly DeckDefinition[], profileId?: string) => storage.set(profileId ? `${savedDecksKey}:${profileId}` : savedDecksKey, decks);

export function deckElixirLabel(deck: Pick<DeckDefinition, "cards">, catalog: readonly ArenaCard[]) {
  const byKey = new Map(catalog.map((card) => [card.key, card]));
  const keys = deck.cards.filter((key) => key !== "mirror");
  const average = keys.length ? keys.reduce((total, key) => total + (byKey.get(key)?.elixir ?? 0), 0) / keys.length : 0;
  return `${average.toFixed(1)} avg${deck.cards.includes("mirror") ? " · Mirror varies" : ""}`;
}

export const createDeckId = () => `local-${typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export function orderedDeckKeys(deck: Pick<DeckDefinition, "cards" | "forms">) {
  const remaining = [...deck.cards];
  const take = (predicate: (key: string) => boolean) => {
    const index = remaining.findIndex(predicate);
    return index < 0 ? undefined : remaining.splice(index, 1)[0];
  };
  const form = (key: string) => deck.forms?.[key] ?? "base";
  const evolution = take((key) => form(key) === "evolution");
  const heroChampion = take((key) => form(key) === "hero" || form(key) === "champion");
  const wild = take((key) => form(key) !== "base");
  const takeBase = () => take((key) => form(key) === "base");
  return [evolution ?? takeBase(), heroChampion ?? takeBase(), wild ?? takeBase(), ...remaining].filter((key): key is string => Boolean(key));
}

export function clashDeckLink(deck: Pick<DeckDefinition, "cards" | "forms">, cardsByKey: ReadonlyMap<string, ArenaCard>) {
  if (deck.cards.length !== 8) return "";
  const ids = orderedDeckKeys(deck).map((key) => cardsByKey.get(key)?.id);
  if (ids.some((id) => id === undefined)) return "";
  try { return buildClashRoyaleDeckLink(ids as number[]); }
  catch { return ""; }
}

const encodePayload = (payload: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const decodePayload = (encoded: string): unknown => {
  const padded = encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
};

export function deckShareUrl(deck: DeckDefinition) {
  const url = new URL(window.location.href);
  url.searchParams.delete("pair");
  url.searchParams.set("deck", encodePayload({ v: 1, deck }));
  url.hash = "decks";
  return url.toString();
}

export function pairShareUrl(pair: [DeckDefinition, DeckDefinition]) {
  const url = new URL(window.location.href);
  url.searchParams.delete("deck");
  url.searchParams.set("pair", encodePayload({ v: 1, pair }));
  url.hash = "decks";
  return url.toString();
}

const isDeckDefinition = (value: unknown): value is DeckDefinition => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const deck = value as Partial<DeckDefinition>;
  const source = deck.source as Partial<DeckDefinition["source"]> | undefined;
  const forms = deck.forms as Record<string, unknown> | undefined;
  return typeof deck.id === "string" && deck.id.length > 0 && deck.id.length <= 100
    && typeof deck.name === "string" && deck.name.trim().length > 0 && deck.name.length <= 80
    && Array.isArray(deck.cards) && deck.cards.length === 8 && new Set(deck.cards).size === 8
    && deck.cards.every((key) => typeof key === "string" && key.length > 0 && key.length <= 100)
    && ["2v2", "classic", "chaos", "mirror", "custom"].includes(String(deck.mode))
    && Boolean(source && ["video", "supercell", "royaleapi", "community", "local"].includes(String(source.kind)) && typeof source.label === "string" && source.label.length > 0 && source.label.length <= 160)
    && (forms === undefined || (forms !== null && typeof forms === "object" && !Array.isArray(forms)
      && Object.entries(forms).every(([key, form]) => deck.cards!.includes(key) && ["base", "evolution", "hero", "champion"].includes(String(form)))));
};

export function sharedDeckFromLocation(): DeckDefinition | null {
  const encoded = new URL(window.location.href).searchParams.get("deck");
  if (!encoded) return null;
  try {
    const decoded = decodePayload(encoded) as { v?: unknown; deck?: unknown };
    return decoded.v === 1 && isDeckDefinition(decoded.deck) ? decoded.deck : null;
  } catch { return null; }
}

export function sharedPairFromLocation(): [DeckDefinition, DeckDefinition] | null {
  const encoded = new URL(window.location.href).searchParams.get("pair");
  if (!encoded) return null;
  try {
    const decoded = decodePayload(encoded) as { v?: unknown; pair?: unknown };
    return decoded.v === 1 && Array.isArray(decoded.pair) && decoded.pair.length === 2
      && decoded.pair.every(isDeckDefinition) ? decoded.pair as [DeckDefinition, DeckDefinition] : null;
  } catch { return null; }
}

export function clearSharedDeckLocation() {
  const url = new URL(window.location.href);
  url.searchParams.delete("deck");
  url.searchParams.delete("pair");
  window.history.replaceState(null, "", `${url.pathname}${url.search}#decks`);
}

export function parseDeckImport(value: string, catalog: readonly ArenaCard[]): string[] | null {
  const input = value.trim();
  if (!input) return null;
  const byId = new Map(catalog.map((card) => [String(card.id), card.key]));
  const byKey = new Map(catalog.map((card) => [card.key.toLowerCase(), card.key]));
  let tokens: string[] = [];
  try {
    const url = new URL(input);
    if (url.protocol === "clashroyale:") tokens = (url.searchParams.get("deck") ?? "").split(/[;,]/);
    if (!tokens.length && url.searchParams.has("deck")) tokens = (url.searchParams.get("deck") ?? "").split(/[;,]/);
    if (!tokens.length) {
      for (const [key, item] of url.searchParams) {
        if (key.includes("copyDeck?deck")) { tokens = item.split(/[;,]/); break; }
      }
    }
    if (!tokens.length) {
      const royaleStats = url.pathname.match(/\/decks\/stats\/([^/?#]+)/i)?.[1];
      if (royaleStats) tokens = decodeURIComponent(royaleStats).split(",");
    }
  } catch {
    tokens = input.split(/[;,\s]+/);
  }
  const keys = tokens.map((token) => byId.get(token.trim()) ?? byKey.get(token.trim().toLowerCase())).filter((key): key is string => Boolean(key));
  return keys.length === 8 && new Set(keys).size === 8 ? keys : null;
}

export function cloneDeck(deck: DeckDefinition, overrides: Partial<DeckDefinition> = {}): DeckDefinition {
  const forms: Partial<Record<string, ArenaForm>> = {};
  for (const key of deck.cards) forms[key] = deck.forms?.[key] ?? "base";
  return { ...deck, ...overrides, cards: [...deck.cards], forms, source: overrides.source ?? deck.source };
}

export function pairDecksFromSeed(pairs: readonly DeckPair[]) {
  return pairs.flatMap((pair) => pair.decks);
}
