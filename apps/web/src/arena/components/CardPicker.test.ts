import { describe, expect, it } from "vitest";
import type { ArenaCard } from "@draft-royale/shared";
import { filterPickerCards, toggledPickerRoles, type PickerRole } from "./CardPicker";

const card = (key: string, overrides: Partial<ArenaCard> = {}): ArenaCard => ({
  key, id: 26_000_000, name: key, elixir: 3, rarity: "common", kind: "troop", families: [],
  forms: [{ key: "base", label: key, asset: `/${key}.png` }], ...overrides,
});
const cards = [
  card("archers", { families: ["anti-air"] }),
  card("baby-dragon", { rarity: "epic", elixir: 4, families: ["anti-air", "flying"] }),
  card("knight"),
  card("fireball", { id: 28_000_000, kind: "spell", rarity: "rare", elixir: 4, families: ["spell", "anti-air"] }),
];

describe("CardPicker filters", () => {
  it("combines tactical roles with AND semantics", () => {
    const roles = new Set<PickerRole>(["anti-air", "ranged"]);
    expect(filterPickerCards(cards, { search: "", kind: "all", roles, rarity: "all", elixir: null }).map((item) => item.key)).toEqual(["archers", "baby-dragon"]);
    roles.add("flying");
    expect(filterPickerCards(cards, { search: "", kind: "all", roles, rarity: "all", elixir: null }).map((item) => item.key)).toEqual(["baby-dragon"]);
  });

  it("keeps Flying and Ground mutually exclusive while preserving other roles", () => {
    const initial = new Set<PickerRole>(["anti-air", "flying"]);
    const next = toggledPickerRoles(initial, "ground");
    expect([...next].sort()).toEqual(["anti-air", "ground"]);
    expect([...initial].sort()).toEqual(["anti-air", "flying"]);
  });

  it("combines kind, rarity, elixir, and search without mutating the catalog", () => {
    const before = JSON.stringify(cards);
    expect(filterPickerCards(cards, { search: "fire", kind: "spell", roles: new Set(), rarity: "rare", elixir: 4 }).map((item) => item.key)).toEqual(["fireball"]);
    expect(JSON.stringify(cards)).toBe(before);
  });

  it("excludes a variable-cost card from a numeric elixir selection", () => {
    const mirror = card("mirror", { id: 28_000_006, elixir: { kind: "previous_card_plus", surcharge: 1 } });
    expect(filterPickerCards([...cards, mirror], { search: "", kind: "all", roles: new Set(), rarity: "all", elixir: 1 })).not.toContain(mirror);
    expect(filterPickerCards([...cards, mirror], { search: "", kind: "all", roles: new Set(), rarity: "all", elixir: null })).toContain(mirror);
  });
});
