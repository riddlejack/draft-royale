import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ArenaCard } from "@draft-royale/shared";
import { repoRoot } from "../config.js";
import { createDeckService, validateLibraryDeck } from "./service.js";

const catalog = (JSON.parse(readFileSync(path.join(repoRoot, "data/catalog/arena-catalog.json"), "utf8")) as { cards: ArenaCard[] }).cards;
const sample = { id: "local-hog", name: "Hog 2.6", mode: "classic", cards: ["hog-rider", "musketeer", "ice-golem", "skeletons", "ice-spirit", "cannon", "fireball", "the-log"] };
const services: ReturnType<typeof createDeckService>[] = [];
afterEach(() => services.splice(0).forEach((service) => service.close()));
function setup() { const service = createDeckService({ catalog, databasePath: ":memory:" }); services.push(service); return service; }

describe("owned deck library", () => {
  it("keeps private drafts out of community, persists publication, and isolates owners", () => {
    const service = setup();
    const first = service.save("alice", "Alice", { commandId: "one", deck: sample });
    expect(service.list()).toEqual([]);
    expect(service.list("bob")).toEqual([]);
    expect(service.list("alice")).toHaveLength(1);
    const published = service.save("alice", "Alice", { commandId: "two", visibility: "public", deck: first });
    expect(service.list()).toEqual([published]);
    expect(() => service.save("bob", "Bob", { commandId: "three", deck: published })).toThrow("Only the deck's author");
    expect(() => service.remove("bob", published.id)).toThrow("Only the author");
    service.remove("alice", published.id);
    expect(service.list()).toEqual([]);
  });
  it("shares published decks only with the owners a viewer is allowed to see", () => {
    const service = setup();
    service.save("alice", "Alice", { commandId: "one", visibility: "public", deck: sample });
    service.save("alice", "Alice", { commandId: "two", visibility: "private", deck: { ...sample, id: "local-private", name: "Secret" } });
    service.save("carol", "Carol", { commandId: "one", visibility: "public", deck: { ...sample, name: "Carol's Hog" } });
    expect(service.listPublishedBy(["bob", "alice"]).map((deck) => deck.name)).toEqual(["Hog 2.6"]);
    expect(service.listPublishedBy(["bob"])).toEqual([]);
    expect(service.listPublishedBy([])).toEqual([]);
  });
  it("makes retries idempotent and rejects reused operation IDs", () => {
    const service = setup();
    const body = { commandId: "one", visibility: "public", deck: sample };
    expect(service.save("a", "A", body)).toEqual(service.save("a", "A", body));
    expect(service.list()).toHaveLength(1);
    expect(() => service.save("a", "A", { ...body, deck: { ...sample, name: "Different" } })).toThrow("already used");
  });
  it("rejects duplicate cards, nonexistent forms, invalid Mirror and Chaos decks", () => {
    expect(() => validateLibraryDeck({ ...sample, cards: Array(8).fill("knight") }, catalog)).toThrow("eight different");
    expect(() => validateLibraryDeck({ ...sample, forms: { "hog-rider": "champion" } }, catalog)).toThrow("does not have");
    expect(() => validateLibraryDeck({ ...sample, forms: { "golem": "base" } }, catalog)).toThrow("belong to cards");
    expect(() => validateLibraryDeck({ ...sample, mode: "mirror" }, catalog)).toThrow("Mirror card");
    expect(() => validateLibraryDeck({ ...sample, mode: "chaos" }, catalog)).toThrow("unavailable");
  });
});
