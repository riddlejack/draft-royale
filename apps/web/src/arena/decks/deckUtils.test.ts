import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArenaCard, DeckDefinition } from "@draft-royale/shared";
import { clashDeckLink, deckCollectionIssues, deckElixirLabel, deckShareUrl, orderedDeckKeys, parseDeckImport, readSavedDecks, sharedDeckFromLocation } from "./deckUtils";

const cards: ArenaCard[] = Array.from({ length: 8 }, (_, index) => ({
  key: `card-${index}`,
  id: 26_000_000 + index,
  name: `Card ${index}`,
  elixir: index + 1,
  rarity: "common",
  kind: "troop",
  families: [],
  forms: [
    { key: "base" as const, label: `Card ${index}`, asset: `/card-${index}.png` },
    ...(index === 3 || index === 7 ? [{ key: "evolution" as const, label: `Card ${index} Evolution`, asset: `/card-${index}-ev1.png` }] : []),
    ...(index === 5 ? [{ key: "hero" as const, label: `Hero Card ${index}`, asset: `/card-${index}-hero.png` }] : []),
  ],
}));
const deck: DeckDefinition = {
  id: "fixture", name: "Fixture deck", mode: "2v2", cards: cards.map((card) => card.key),
  forms: { "card-3": "evolution", "card-5": "hero", "card-7": "evolution" },
  source: { kind: "local", label: "Test" },
};

describe("deck workshop utilities", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves the requested deck order in exports, including special forms", () => {
    expect(orderedDeckKeys(deck)).toEqual(["card-3", "card-5", "card-7", "card-0", "card-1", "card-2", "card-4", "card-6"]);
    const link = decodeURIComponent(clashDeckLink(deck, new Map(cards.map((card) => [card.key, card]))));
    expect(link).toContain("copyDeck?deck=26000000;26000001;26000002;26000003;26000004;26000005;26000006;26000007");
  });

  it("imports standard Clash and RoyaleAPI deck links", () => {
    const ids = cards.map((card) => card.id).join(";");
    expect(parseDeckImport(`https://link.clashroyale.com/deck/en?deck=${ids}&l=en`, cards)).toEqual(deck.cards);
    expect(parseDeckImport(`https://royaleapi.com/decks/stats/${deck.cards.join(",")}`, cards)).toEqual(deck.cards);
  });

  it("blocks cards and special forms missing from an imported collection", () => {
    expect(deckCollectionIssues(deck, cards, {
      cards: deck.cards.filter((key) => key !== "card-0"),
      forms: { "card-3": ["evolution"], "card-5": [], "card-7": ["evolution"] },
      source: "api",
      profile: { tag: "#P0Y", name: "Known player", fetchedAt: "2026-09-20T12:00:00.000Z" },
    })).toEqual([
      "Card 0 is not in My cards.",
      "Hero Card 5 is not unlocked in My cards.",
    ]);
  });

  it("does not publish a made-up average for a deck with Mirror", () => {
    const mirror = { ...cards[0]!, key: "mirror", id: 28_000_006, name: "Mirror", elixir: { kind: "previous_card_plus" as const, surcharge: 1 } };
    const mirrorDeck = { cards: ["mirror", ...cards.slice(1).map((card) => card.key)] };
    const catalog = [mirror, ...cards.slice(1)];
    expect(deckElixirLabel(mirrorDeck, catalog)).toBe("— avg · Mirror varies");
    expect(decodeURIComponent(clashDeckLink(mirrorDeck, new Map(catalog.map((card) => [card.key, card]))))).toContain("copyDeck?deck=28000006");
  });

  it("removes a stale pair payload when building a deck share URL", () => {
    vi.stubGlobal("window", { location: { href: "https://draft.example/?pair=stale#room=secret" } });
    const url = new URL(deckShareUrl(deck));
    expect(url.searchParams.has("pair")).toBe(false);
    expect(url.searchParams.has("deck")).toBe(true);
    expect(url.hash).toBe("#decks");
  });

  it("rejects malformed shared and locally saved decks", () => {
    vi.stubGlobal("window", { location: { href: "https://draft.example/?deck=eyJ2IjoxLCJkZWNrIjp7Im5hbWUiOiJCYWQifX0#decks" } });
    expect(sharedDeckFromLocation()).toBeNull();
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ id: "not-an-array" }) });
    expect(readSavedDecks()).toEqual([]);
  });
});
