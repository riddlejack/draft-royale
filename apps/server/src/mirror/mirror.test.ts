import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ArenaCard, DeckDefinition, MirrorRoomView } from "@draft-royale/shared";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { buildMirrorRemixCandidates, createMirrorRoomRouter, createMirrorRoomService, type MirrorRoomService } from "./index.js";

const catalog: ArenaCard[] = [
  {
    key: "mirror", id: 28_000_006, name: "Mirror", elixir: 1, rarity: "epic", kind: "spell", families: ["spell"],
    forms: [{ key: "base", label: "Base", asset: "/mirror.png" }],
  },
  ...Array.from({ length: 24 }, (_, index) => ({
    key: `card-${index + 1}`,
    id: 26_000_000 + index,
    name: `Card ${index + 1}`,
    elixir: index % 9 + 1,
    rarity: index % 2 ? "rare" : "common",
    kind: "troop",
    families: index % 3 ? [] : ["anti-air"],
    forms: [{ key: "base" as const, label: "Base", asset: `/card-${index + 1}.png` }],
  })),
];

const deck = (id: string, name: string, start: number, mode: DeckDefinition["mode"], source: DeckDefinition["source"]): DeckDefinition => ({
  id,
  name,
  mode,
  cards: Array.from({ length: 8 }, (_, index) => `card-${start + index}`),
  source,
  tags: [mode],
});

const decks: DeckDefinition[] = [
  deck("classic-one", "Classic One", 1, "classic", { kind: "royaleapi", label: "Classic source one", url: "https://example.test/classic-one" }),
  deck("classic-two", "Classic Two", 9, "classic", { kind: "supercell", label: "Classic source two" }),
  deck("community-one", "Community One", 2, "custom", { kind: "community", label: "Alex" }),
  deck("chaos-one", "Chaos One", 10, "chaos", { kind: "community", label: "Chaos source" }),
];

const roots: string[] = [];
const services: MirrorRoomService[] = [];
const createDatabase = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-room-"));
  roots.push(root);
  return path.join(root, "arena.sqlite");
};
const service = (databasePath = createDatabase()) => {
  const result = createMirrorRoomService({ databasePath, catalog, getDecks: () => decks });
  services.push(result);
  return result;
};
const next = (room: MirrorRoomView, commandId: string) => ({ action: "next" as const, expectedRevision: room.revision, commandId });

afterEach(() => {
  for (const running of services.splice(0)) {
    try { running.close(); } catch { /* already closed in a restart test */ }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Mirror remix candidates", () => {
  it("generates bounded legal variants, preserves source locators, and labels them as unofficial", () => {
    const variants = buildMirrorRemixCandidates(decks, catalog);
    const compositions = variants.map(({ deck: candidate }) => JSON.stringify([...candidate.cards].sort().map((key) => [key, candidate.forms?.[key] ?? "base"])));
    expect(variants).toHaveLength(23);
    expect(new Set(compositions)).toHaveLength(variants.length);
    expect(variants.every(({ deck: candidate }) => candidate.cards.length === 8 && new Set(candidate.cards).size === 8 && candidate.cards.includes("mirror"))).toBe(true);
    expect(variants.every(({ deck: candidate }) => candidate.mode === "mirror" && candidate.source.label.includes("not official"))).toBe(true);
    expect(variants.some(({ deck: candidate }) => candidate.source.url === "https://example.test/classic-one")).toBe(true);
    expect(variants.some(({ deck: candidate }) => candidate.source.label.includes("Chaos source"))).toBe(false);
  });

  it("deduplicates equivalent rosters across card order, form order, and implicit base forms", () => {
    const cards = Array.from({ length: 8 }, (_, index) => `card-${index + 1}`);
    const implicit = deck("implicit", "Implicit base", 1, "classic", { kind: "local", label: "Implicit" });
    const reversedCards = [...cards].reverse();
    const explicitReversed: DeckDefinition = {
      ...implicit,
      id: "explicit-reversed",
      name: "Explicit reversed",
      cards: reversedCards,
      forms: Object.fromEntries(reversedCards.map((key) => [key, "base"])),
    };
    const explicitPermuted: DeckDefinition = {
      ...implicit,
      id: "explicit-permuted",
      name: "Explicit permuted",
      forms: Object.fromEntries([cards[3], cards[1], cards[7], cards[0], cards[6], cards[2], cards[5], cards[4]].map((key) => [key, "base"])),
    };

    const variants = buildMirrorRemixCandidates([implicit, explicitReversed, explicitPermuted], catalog);
    const compositions = variants.map(({ deck: candidate }) =>
      JSON.stringify([...candidate.cards].sort().map((key) => [key, candidate.forms?.[key] ?? "base"])),
    );
    expect(variants).toHaveLength(8);
    expect(new Set(compositions)).toHaveLength(8);
  });
});

describe("synchronized Mirror room service", () => {
  it("gives both authenticated seats the identical deck without leaking either token", () => {
    const databasePath = createDatabase();
    const mirror = service(databasePath);
    const host = mirror.create({ name: "Host", playlist: "mirror" });
    const guest = mirror.join({ code: host.room.code.toLowerCase(), name: "Guest" });
    const hostView = mirror.get(host.room.id, host.credential.token);
    const guestView = mirror.get(host.room.id, guest.credential.token);
    expect(hostView.deck).toEqual(guestView.deck);
    expect(hostView).toMatchObject({ viewer: "a", hostName: "Host", guestName: "Guest" });
    expect(guestView.viewer).toBe("b");
    expect(JSON.stringify([hostView, guestView])).not.toContain(host.credential.token);
    expect(JSON.stringify([hostView, guestView])).not.toContain(guest.credential.token);

    const db = new DatabaseSync(databasePath);
    const stored = db.prepare("SELECT state_json FROM mirror_rooms WHERE id=?").get(host.room.id) as { state_json: string };
    expect(stored.state_json).not.toContain(host.credential.token);
    expect(stored.state_json).not.toContain(guest.credential.token);
    db.close();

    expect(() => mirror.get(host.room.id, "wrong-token")).toThrowError(/credentials/i);
    expect(() => mirror.command(host.room.id, guest.credential.token, next(guestView, "guest-next"))).toThrowError(/Only the host/i);
  });

  it("does not repeat before playlist exhaustion and makes retries idempotent", () => {
    const mirror = service();
    const session = mirror.create({ name: "Host", playlist: "classics" });
    const firstId = session.room.deck.id;
    const second = mirror.command(session.room.id, session.credential.token, next(session.room, "next-1"));
    expect(second.deck.id).not.toBe(firstId);
    const duplicate = mirror.command(session.room.id, session.credential.token, next(session.room, "next-1"));
    expect(duplicate).toEqual(second);
    const recycled = mirror.command(session.room.id, session.credential.token, next(second, "next-2"));
    expect(new Set([firstId, second.deck.id])).toContain(recycled.deck.id);
    expect(() => mirror.command(session.room.id, session.credential.token, { ...next(second, "stale-next"), expectedRevision: second.revision })).toThrowError(/room changed/i);
    expect(() => mirror.command(session.room.id, session.credential.token, { ...next(recycled, "next-1") })).toThrowError(/operation|commandId/i);
  });

  it("restores an edited deck with honest remix provenance through previous navigation", () => {
    const mirror = service();
    const session = mirror.create({ name: "Host", playlist: "classics" });
    const originalSource = session.room.deck.source;
    const keptCards = session.room.deck.cards.slice(0, 7);
    const editedDeck = {
      ...session.room.deck,
      name: "Our version",
      cards: [...keptCards, "card-24"],
      forms: Object.fromEntries(Object.entries(session.room.deck.forms ?? {}).filter(([key]) => keptCards.includes(key))),
    };
    const edited = mirror.command(session.room.id, session.credential.token, {
      action: "edit", expectedRevision: session.room.revision, commandId: "edit-1", deck: editedDeck,
    });
    expect(edited.deck.name).toBe("Our version");
    expect(edited.deck.id).toMatch(/^mirror-room-deck-/);
    expect(edited.deck.id).not.toBe(session.room.deck.id);
    expect(edited.deck.source).toEqual({ kind: "local", label: `Custom remix of ${originalSource.label}` });
    expect(edited.deck.source.url).toBeUndefined();
    expect(edited.deck.source.confidence).toBeUndefined();
    const advanced = mirror.command(session.room.id, session.credential.token, next(edited, "next-after-edit"));
    const restored = mirror.command(session.room.id, session.credential.token, {
      action: "previous", expectedRevision: advanced.revision, commandId: "previous-1",
    });
    expect(restored.deck.name).toBe("Our version");
    expect(restored.deck.cards).toEqual(editedDeck.cards);
    expect(restored.deck.source).toEqual(edited.deck.source);

    const editedAgain = mirror.command(session.room.id, session.credential.token, {
      action: "edit", expectedRevision: restored.revision, commandId: "edit-2", deck: restored.deck,
    });
    expect(editedAgain.deck.id).toBe(restored.deck.id);
    expect(editedAgain.deck.source.label).toBe(`Custom remix of ${originalSource.label}`);
  });

  it("enforces Mirror on Mirror edits while other playlists accept any legal eight-card deck", () => {
    const mirror = service();
    const mirrorRoom = mirror.create({ name: "Host", playlist: "mirror" });
    expect(() => mirror.command(mirrorRoom.room.id, mirrorRoom.credential.token, {
      action: "edit", expectedRevision: mirrorRoom.room.revision, commandId: "bad-mirror-edit",
      deck: deck("bad", "No Mirror", 1, "custom", { kind: "local", label: "Test" }),
    })).toThrowError(/must contain the Mirror card/i);

    const classicRoom = mirror.create({ name: "Host", playlist: "classics", deck: deck("custom", "Custom", 3, "custom", { kind: "local", label: "Test" }) });
    expect(classicRoom.room.deck.cards).not.toContain("mirror");
  });

  it("persists synchronized history and credentials across a service restart", () => {
    const databasePath = createDatabase();
    let mirror = service(databasePath);
    const host = mirror.create({ name: "Host", playlist: "classics" });
    const guest = mirror.join({ code: host.room.code, name: "Guest" });
    const durableNext = next(mirror.get(host.room.id, host.credential.token), "durable-next");
    const advanced = mirror.command(host.room.id, host.credential.token, durableNext);
    mirror.close();
    services.splice(services.indexOf(mirror), 1);

    mirror = service(databasePath);
    expect(mirror.get(host.room.id, host.credential.token)).toMatchObject({ revision: advanced.revision, deck: advanced.deck, historyCount: 2, viewer: "a" });
    expect(mirror.get(host.room.id, guest.credential.token)).toMatchObject({ revision: advanced.revision, deck: advanced.deck, historyCount: 2, viewer: "b" });
    expect(mirror.command(host.room.id, host.credential.token, durableNext)).toEqual(advanced);
  });

  it("rejects a stale host command loaded through another service instance", () => {
    const databasePath = createDatabase();
    const first = service(databasePath);
    const second = service(databasePath);
    const host = first.create({ name: "Host", playlist: "classics" });
    const staleView = second.get(host.room.id, host.credential.token);
    const advanced = first.command(host.room.id, host.credential.token, next(host.room, "first-writer"));

    expect(() => second.command(host.room.id, host.credential.token, next(staleView, "stale-second-writer"))).toThrowError(/room changed/i);
    expect(second.get(host.room.id, host.credential.token)).toMatchObject({ revision: advanced.revision, deck: advanced.deck });
  });
});

describe("Mirror room HTTP contract", () => {
  it("supports create, join, authenticated polling, and host-only commands", async () => {
    const mirror = service();
    const app = express().use(express.json()).use(createMirrorRoomRouter(mirror));
    const created = await request(app).post("/api/mirror/rooms").send({ name: "Host", playlist: "classics" }).expect(201);
    const joined = await request(app).post("/api/mirror/join").send({ code: created.body.room.code, name: "Guest" }).expect(201);
    const polled = await request(app).get(`/api/mirror/rooms/${created.body.room.id}`).set("authorization", `Bearer ${joined.body.credential.token}`).expect(200);
    expect(polled.body.room.deck).toEqual(created.body.room.deck);
    await request(app).post(`/api/mirror/rooms/${created.body.room.id}/command`).set("authorization", `Bearer ${joined.body.credential.token}`).send({ action: "next", expectedRevision: polled.body.room.revision, commandId: "guest-http-next" }).expect(403);
    const nextRoom = await request(app).post(`/api/mirror/rooms/${created.body.room.id}/command`).set("authorization", `Bearer ${created.body.credential.token}`).send({ action: "next", expectedRevision: polled.body.room.revision, commandId: "host-http-next" }).expect(200);
    expect(nextRoom.body.room.deck).not.toEqual(polled.body.room.deck);
    await request(app).get(`/api/mirror/rooms/${created.body.room.id}`).expect(401);
  });
});
