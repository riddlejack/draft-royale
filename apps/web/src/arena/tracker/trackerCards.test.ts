import { describe, expect, it } from "vitest";
import type { ArenaCard, ArenaForm, TrackerCard } from "@draft-royale/shared";
import { cardStatKey, catalogById, catalogForm, formBadge, resolveTrackerCard, trackerCardLabel } from "./trackerCards";

const card = (key: string, id: number, forms: ArenaForm[] = ["base"]): ArenaCard => ({ key, id, name: key, elixir: 3, rarity: "common", kind: "troop", families: [], forms: forms.map((form) => ({ key: form, label: `${key} ${form}`, asset: `/${key}-${form}.png` })) });
const tracked = (id: number | null, form: TrackerCard["form"] = "base", name = "Card"): TrackerCard => ({ id, key: name.toLowerCase(), name, form, elixirCost: 3 });
const catalog = [card("knight", 26_000_000, ["base", "evolution", "hero"]), card("musketeer", 26_000_014, ["base", "hero"]), card("little-prince", 26_000_093, ["champion"])];
const cardsById = catalogById(catalog);

describe("tracker card to catalog mapping", () => {
  it("resolves a tracked card by its Clash id and keeps the matching form", () => {
    expect(resolveTrackerCard(tracked(26_000_000, "evolution"), cardsById)).toMatchObject({ card: { key: "knight" }, form: "evolution" });
    expect(resolveTrackerCard(tracked(26_000_093, "champion"), cardsById)).toMatchObject({ card: { key: "little-prince" }, form: "champion" });
  });

  it("falls back to base art when the catalog lacks the tracked form", () => {
    expect(catalogForm(catalog[1]!, { form: "evolution" })).toBe("base");
    expect(catalogForm(catalog[0]!, { form: "base" })).toBe("base");
  });

  it("maps a hero evolution to evolution art first, then hero art", () => {
    expect(catalogForm(catalog[0]!, { form: "heroEvolution" })).toBe("evolution");
    expect(catalogForm(catalog[1]!, { form: "heroEvolution" })).toBe("hero");
  });

  it("returns no catalog card for an unknown or missing id instead of guessing by name", () => {
    expect(resolveTrackerCard(tracked(99, "base", "Knight"), cardsById)).toEqual({ tracked: tracked(99, "base", "Knight"), card: null, form: "base" });
    expect(resolveTrackerCard(tracked(null), cardsById).card).toBeNull();
  });

  it("labels forms and keys card stats the way the server does", () => {
    expect(trackerCardLabel(tracked(1, "base", "Knight"))).toBe("Knight");
    expect(trackerCardLabel(tracked(1, "heroEvolution", "Knight"))).toBe("Knight (hero evolution)");
    expect(trackerCardLabel(tracked(1, "evolution", "Knight"))).toBe("Knight (evolution)");
    expect(trackerCardLabel(tracked(1, "champion", "Little Prince"))).toBe("Little Prince");
    expect([formBadge("base"), formBadge("evolution"), formBadge("hero"), formBadge("champion")]).toEqual(["", "E", "H", "C"]);
    expect(cardStatKey({ id: 26_000_000, key: "knight" })).toBe("26000000");
    expect(cardStatKey({ id: null, key: "mystery" })).toBe("mystery");
  });
});
