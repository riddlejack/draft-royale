import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { ArenaCard, ArenaCollectionImportResponse } from "@draft-royale/shared";
import { createCollectionImportRouter } from "./collection-import-router.js";
import { CollectionImportError, createCollectionImportService, normalizePlayerTag } from "./collection-import.js";

const catalog: ArenaCard[] = [
  { key: "base", id: 1, name: "Base", elixir: 2, rarity: "common", kind: "troop", families: [], forms: [{ key: "base", label: "Base", asset: "/base.png" }] },
  { key: "evo", id: 2, name: "Evo", elixir: 3, rarity: "common", kind: "troop", families: [], forms: [{ key: "base", label: "Evo", asset: "/evo.png" }, { key: "evolution", label: "Evo Evolution", asset: "/evo-e.png" }] },
  { key: "hero", id: 3, name: "Hero", elixir: 4, rarity: "rare", kind: "troop", families: [], forms: [{ key: "base", label: "Hero", asset: "/hero.png" }, { key: "hero", label: "Hero Hero", asset: "/hero-h.png" }] },
  { key: "dual", id: 4, name: "Dual", elixir: 5, rarity: "rare", kind: "troop", families: [], forms: [{ key: "base", label: "Dual", asset: "/dual.png" }, { key: "evolution", label: "Dual Evolution", asset: "/dual-e.png" }, { key: "hero", label: "Dual Hero", asset: "/dual-h.png" }] },
  { key: "champion", id: 5, name: "Champion", elixir: 4, rarity: "champion", kind: "troop", families: [], forms: [{ key: "champion", label: "Champion", asset: "/champion.png" }] },
  { key: "missing", id: 6, name: "Missing", elixir: 1, rarity: "common", kind: "troop", families: [], forms: [{ key: "base", label: "Missing", asset: "/missing.png" }] },
];

const profile = {
  tag: "#P0Y",
  name: "Known player",
  cards: [
    { id: 1, name: "Base", level: 4 },
    { id: 2, name: "Evo", level: 4, evolutionLevel: 1 },
    { id: 3, name: "Hero", level: 4, evolutionLevel: 2 },
    { id: 4, name: "Dual", level: 4, evolutionLevel: 3 },
    { id: 5, name: "Champion", level: 4 },
    { id: 999, name: "Future card", level: 1 },
  ],
};

describe("player collection import", () => {
  it("normalizes tags while rejecting display names", () => {
    expect(normalizePlayerTag(" poy ")).toBe("#P0Y");
    expect(() => normalizePlayerTag("Known player")).toThrowError(CollectionImportError);
  });

  it("maps profile cards and the Evo/Hero ownership bit field without inferring missing cards", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(profile), { status: 200, headers: { "Content-Type": "application/json" } }));
    const service = createCollectionImportService({ catalog, apiToken: "secret", fetchImpl: fetchImpl as typeof fetch, now: () => Date.parse("2026-09-20T12:00:00Z") });
    const result = await service.importPlayer("#P0Y");

    expect(result).toMatchObject({ cached: false, stale: false, fetchedAt: "2026-09-20T12:00:00.000Z" });
    expect(result.collection).toEqual({
      cards: ["base", "evo", "hero", "dual", "champion"],
      forms: { evo: ["evolution"], hero: ["hero"], dual: ["evolution", "hero"], champion: ["champion"] },
      source: "api",
      profile: { tag: "#P0Y", name: "Known player", fetchedAt: "2026-09-20T12:00:00.000Z" },
    });
    expect(result.collection.cards).not.toContain("missing");
    expect(result.warnings).toContain("1 profile card was not present in this catalog and stayed unavailable.");
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("players/%23P0Y"), expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret" }) }));
  });

  it("uses a fresh cache and falls back to a bounded stale result on network failure", async () => {
    let timestamp = Date.parse("2026-09-20T12:00:00Z");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(profile), { status: 200 }))
      .mockRejectedValueOnce(new TypeError("offline"));
    const service = createCollectionImportService({ catalog, apiToken: "secret", fetchImpl: fetchImpl as typeof fetch, now: () => timestamp, cacheTtlMs: 5 * 60_000 });
    await service.importPlayer("#P0Y");
    expect((await service.importPlayer("#P0Y")).cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    timestamp += 6 * 60_000;
    const stale = await service.importPlayer("#P0Y");
    expect(stale).toMatchObject({ cached: true, stale: true });
    expect(stale.warnings.at(-1)).toMatch(/last successful import/i);
  });

  it("reports missing server configuration without changing a saved client collection", async () => {
    const service = createCollectionImportService({ catalog });
    await expect(service.importPlayer("#P0Y")).rejects.toMatchObject({ status: 503, code: "API_NOT_CONFIGURED" });
  });
});

describe("collection import HTTP boundary", () => {
  it("rate-limits repeated profile imports", async () => {
    const response: ArenaCollectionImportResponse = {
      collection: { cards: ["base"], forms: {}, source: "api", profile: { tag: "#P0Y", name: "Known player", fetchedAt: "2026-09-20T12:00:00.000Z" } },
      fetchedAt: "2026-09-20T12:00:00.000Z",
      expiresAt: "2026-09-20T12:05:00.000Z",
      cached: true,
      stale: false,
      warnings: [],
    };
    const app = express();
    app.use(express.json());
    app.use(createCollectionImportRouter({ importPlayer: async () => response }));
    for (let requestNumber = 0; requestNumber < 6; requestNumber += 1) {
      await request(app).post("/api/arena/collection/import").send({ tag: "#P0Y" }).expect(200);
    }
    await request(app).post("/api/arena/collection/import").send({ tag: "#P0Y" }).expect(429, { error: "Too many collection imports. Try again shortly.", code: "RATE_LIMITED" });
  });
});
