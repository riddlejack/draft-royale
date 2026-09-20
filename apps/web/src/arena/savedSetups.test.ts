import type { ArenaSettings } from "@draft-royale/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteSavedSetup, readSavedSetups, SAVED_SETUPS_KEY, SAVED_SETUPS_LIMIT, saveSetupCopy } from "./savedSetups";

class MemoryStorage {
  value: string | null = null;
  getItem(key: string) { return key === SAVED_SETUPS_KEY ? this.value : null; }
  setItem(key: string, value: string) { if (key === SAVED_SETUPS_KEY) this.value = value; }
}

const settings: ArenaSettings = {
  mode: "mega", poolSize: 36, pickSeconds: 15, timerMode: "per_pick", specialForms: true,
  battleMode: "Friendly 1v1", maxElixir: 4, cardKinds: ["troop"], rarities: ["common", "rare"], families: ["goblin"],
};

describe("saved battle setups", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips only versioned rule data and strips unrelated secrets", () => {
    const storage = new MemoryStorage();
    const unsafe = { ...settings, token: "do-not-store", roomId: "room-secret" } as ArenaSettings;
    const saved = saveSetupCopy([], " Goblin night ", unsafe, storage);
    const loaded = readSavedSetups(storage);

    expect(saved.error).toBeUndefined();
    expect(loaded.setups).toHaveLength(1);
    expect(loaded.setups[0]).toMatchObject({ name: "Goblin night", settings });
    expect(JSON.stringify(storage.value)).not.toMatch(/do-not-store|room-secret/);
  });

  it("round-trips post-filter pool edits and rejects malformed card ids", () => {
    const storage = new MemoryStorage();
    saveSetupCopy([], "Edited pool", {
      ...settings,
      includedCardIds: [26_000_001, 26_000_002, 26_000_001],
      excludedCardIds: [28_000_003],
    }, storage);
    expect(readSavedSetups(storage).setups[0]?.settings).toMatchObject({
      includedCardIds: [26_000_001, 26_000_002],
      excludedCardIds: [28_000_003],
    });

    const malformed = JSON.parse(storage.value!);
    malformed.setups[0].settings.includedCardIds = ["26000001"];
    storage.value = JSON.stringify(malformed);
    expect(readSavedSetups(storage)).toMatchObject({ setups: [], error: expect.any(String) });
  });

  it("rejects malformed envelopes and skips invalid entries without throwing", () => {
    const storage = new MemoryStorage();
    storage.value = "not json";
    expect(readSavedSetups(storage)).toMatchObject({ setups: [], error: expect.any(String) });

    storage.value = JSON.stringify({ version: 1, setups: [
      { id: "bad", name: "Bad", updatedAt: 1, token: "secret", settings: { mode: "unknown" } },
      { id: "good", name: "Good", updatedAt: 2, settings },
    ] });
    const partial = readSavedSetups(storage);
    expect(partial.setups.map((setup) => setup.id)).toEqual(["good"]);
    expect(partial.error).toMatch(/Some saved battles/);
  });

  it("retains odd caps across reload and normalizes legacy larger caps", () => {
    const storage = new MemoryStorage();
    saveSetupCopy([], "Odd board", { ...settings, poolSize: 23 }, storage);
    expect(readSavedSetups(storage).setups[0]?.settings.poolSize).toBe(23);
    storage.value = JSON.stringify({ version: 1, setups: [
      { id: "legacy", name: "Older large board", updatedAt: 1, settings: { ...settings, poolSize: 48 } },
    ] });
    expect(readSavedSetups(storage).setups[0]?.settings.poolSize).toBe(36);
  });

  it("persists an opt-in grouped round schedule and rejects malformed flags", () => {
    const storage = new MemoryStorage();
    saveSetupCopy([], "Grouped Triple", { ...settings, mode: "triple", groupedSpecialRounds: true }, storage);
    expect(readSavedSetups(storage).setups[0]?.settings.groupedSpecialRounds).toBe(true);
    const malformed = JSON.parse(storage.value!);
    malformed.setups[0].settings.groupedSpecialRounds = "true";
    storage.value = JSON.stringify(malformed);
    expect(readSavedSetups(storage)).toMatchObject({ setups: [], error: expect.any(String) });
  });

  it("round-trips mirror mode strictly and defaults older setups off", () => {
    const storage = new MemoryStorage();
    saveSetupCopy([], "Mirror battle", { ...settings, mirrorMode: true }, storage);
    expect(readSavedSetups(storage).setups[0]?.settings.mirrorMode).toBe(true);

    const malformed = JSON.parse(storage.value!);
    malformed.setups[0].settings.mirrorMode = "true";
    storage.value = JSON.stringify(malformed);
    expect(readSavedSetups(storage)).toMatchObject({ setups: [], error: expect.any(String) });

    storage.value = JSON.stringify({ version: 1, setups: [
      { id: "legacy", name: "Legacy", updatedAt: 1, settings },
    ] });
    expect(readSavedSetups(storage).setups[0]?.settings.mirrorMode).toBe(false);
  });

  it("normalizes stale Infinite Elixir setups to base-only rules", () => {
    const storage = new MemoryStorage();
    saveSetupCopy([], "Old Chaos", {
      ...settings,
      mode: "triple",
      battleMode: "Chaos friendly battle",
      specialForms: true,
      groupedSpecialRounds: true,
    }, storage);
    expect(readSavedSetups(storage).setups[0]?.settings).toMatchObject({
      battleMode: "Chaos friendly battle",
      specialForms: false,
      groupedSpecialRounds: false,
    });
  });

  it("refuses a thirteenth copy without deleting a named setup and persists deletion", () => {
    const storage = new MemoryStorage();
    let setups = readSavedSetups(storage).setups;
    for (let index = 0; index < SAVED_SETUPS_LIMIT; index += 1) setups = saveSetupCopy(setups, `Setup ${index}`, settings, storage).setups;
    expect(setups).toHaveLength(SAVED_SETUPS_LIMIT);
    const full = saveSetupCopy(setups, "Setup 12", settings, storage);
    expect(full.setups).toEqual(setups);
    expect(full.error).toMatch(/Delete a saved battle/);
    expect(setups.some((setup) => setup.name === "Setup 0")).toBe(true);

    const removed = deleteSavedSetup(setups, setups[0]!.id, storage);
    expect(readSavedSetups(storage).setups).toEqual(removed.setups);
  });

  it("reports storage failures and leaves the visible list unchanged", () => {
    const storage = new MemoryStorage();
    const first = saveSetupCopy([], "First", settings, storage).setups;
    const failing = { getItem: () => storage.value, setItem: () => { throw new Error("denied"); } };
    const result = saveSetupCopy(first, "Second", settings, failing);
    expect(result.setups).toEqual(first);
    expect(result.error).toMatch(/unavailable/);
  });

  it("handles a blocked window.localStorage getter", () => {
    const blockedWindow = Object.defineProperty({}, "localStorage", { get() { throw new Error("blocked"); } });
    vi.stubGlobal("window", blockedWindow);
    expect(readSavedSetups()).toMatchObject({ setups: [], error: expect.stringMatching(/unavailable/) });
  });
});
