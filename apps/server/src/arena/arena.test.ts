import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { filterArenaCards, isChaosSupportedCard, isFixedArenaElixirCost, type ArenaCard, type ArenaSettings, type ArenaView } from "@draft-royale/shared";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createArenaApp, createArenaService, type ArenaService } from "./index.js";

const catalog: ArenaCard[] = [
  ...Array.from({ length: 64 }, (_, index) => ({
    key: `card-${index + 1}`,
    id: 26_000_000 + index,
    name: `Card ${index + 1}`,
    elixir: (index % 9) + 1,
    rarity: index % 2 ? "rare" : "common",
    kind: "troop",
    families: index % 5 === 0 ? ["cycle"] : [],
    forms: [
      { key: "base" as const, label: "Base", asset: `/card-${index + 1}.png` },
      ...(index % 3 === 0 ? [{ key: "evolution" as const, label: "Evolution", asset: `/card-${index + 1}-evo.png` }] : []),
      ...(index % 7 === 0 ? [{ key: "hero" as const, label: "Hero", asset: `/card-${index + 1}-hero.png` }] : []),
      ...(index % 11 === 0 ? [{ key: "champion" as const, label: "Champion", asset: `/card-${index + 1}-champion.png` }] : []),
    ],
  })),
  {
    key: "mirror",
    id: 28_000_006,
    name: "Mirror",
    elixir: { kind: "previous_card_plus", surcharge: 1 },
    rarity: "epic",
    kind: "spell",
    families: ["spell"],
    forms: [{ key: "base", label: "Mirror", asset: "/mirror.png" }],
  },
];

const realCatalogPayload = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "../../data/catalog/arena-catalog.json"), "utf8"),
) as { version: string; updatedAt: string; cards: ArenaCard[] };

const services: ArenaService[] = [];
const tempRoots: string[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const service = (overrides: Partial<Parameters<typeof createArenaService>[0]> = {}) => {
  const result = createArenaService({
    catalog,
    catalogVersion: "test-v1",
    databasePath: ":memory:",
    initialDealMs: 0,
    presentationDelayMs: 0,
    ...overrides,
  });
  services.push(result);
  return result;
};

const createPair = (arena: ArenaService, mode: "mega" | "triple" | "classic" = "mega", poolSize = 36) => {
  const host = arena.createRoom({ name: "Host", settings: { mode, poolSize, pickSeconds: 120, specialForms: true, battleMode: "Friendly" } });
  const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest" });
  arena.setReady(host.credential.roomId, host.credential.token, { ready: true, commandId: "ready-host" });
  const loading = arena.setReady(guest.credential.roomId, guest.credential.token, { ready: true, commandId: "ready-guest" });
  arena.setLoaded(host.credential.roomId, host.credential.token, { commandId: "loaded-host" });
  const started = arena.setLoaded(guest.credential.roomId, guest.credential.token, { commandId: "loaded-guest" });
  return { host, guest, loading, started };
};

const createPairWithSettings = (
  arena: ArenaService,
  settings: ArenaSettings,
  collections?: { host?: unknown; guest?: unknown },
) => {
  const host = arena.createRoom({ name: "Host", settings, collection: collections?.host });
  const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest", collection: collections?.guest });
  arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "custom-ready-host" });
  const loading = arena.setReady(host.room.id, guest.credential.token, { ready: true, commandId: "custom-ready-guest" });
  arena.setLoaded(host.room.id, host.credential.token, { commandId: "custom-loaded-host" });
  const started = arena.setLoaded(host.room.id, guest.credential.token, { commandId: "custom-loaded-guest" });
  return { host, guest, loading, started };
};

const credentialFor = (pair: ReturnType<typeof createPair>, seat: "a" | "b") => seat === "a" ? pair.host.credential : pair.guest.credential;

const firstLegal = (view: ArenaView) => {
  const cell = view.board.find((candidate) => candidate.legalForms.length > 0);
  if (!cell) throw new Error("Expected a legal cell");
  return { cardKey: cell.cardKey, form: cell.legalForms[0] as "base" | "evolution" | "hero" | "champion" };
};

const completePair = (arena: ArenaService, pair: ReturnType<typeof createPair>, prefix: string) => {
  if (pair.started.settings.mode === "mega") {
    let view = pair.started;
    for (let pick = 0; pick < 16; pick += 1) {
      const credential = credentialFor(pair, view.activeSeat as "a" | "b");
      view = arena.getView(view.id, credential.token);
      view = arena.pick(view.id, credential.token, { ...firstLegal(view), commandId: `${prefix}-${pick}`, expectedRevision: view.revision });
    }
    return arena.getView(pair.host.room.id, pair.host.credential.token);
  }
  const decisions = pair.started.settings.mode === "classic" ? 4 : 8;
  for (let pick = 0; pick < decisions; pick += 1) {
    for (const credential of [pair.host.credential, pair.guest.credential]) {
      const view = arena.getView(pair.host.room.id, credential.token);
      arena.pick(view.id, credential.token, { ...firstLegal(view), commandId: `${prefix}-${credential.seat}-${pick}`, expectedRevision: view.revision });
    }
  }
  return arena.getView(pair.host.room.id, pair.host.credential.token);
};

const completeMirrorPair = (arena: ArenaService, pair: ReturnType<typeof createPairWithSettings>, prefix: string) => {
  let view = arena.getView(pair.host.room.id, pair.host.credential.token);
  for (let pick = 0; pick < view.totalPicks; pick += 1) {
    const credential = credentialFor(pair, view.activeSeat as "a" | "b");
    view = arena.getView(view.id, credential.token);
    view = arena.pick(view.id, credential.token, {
      ...firstLegal(view),
      commandId: `${prefix}-${pick}`,
      expectedRevision: view.revision,
    });
  }
  return arena.getView(pair.host.room.id, pair.host.credential.token);
};

describe("authoritative arena service", () => {
  it("creates an invited room atomically and idempotently from pre-hashed seat tokens", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arena-invited-room-"));
    tempRoots.push(tempRoot);
    const databasePath = path.join(tempRoot, "arena.sqlite");
    const arena = service({ databasePath });
    const hostToken = "host-derived-room-token-unique-value";
    const guestToken = "guest-derived-room-token-unique-value";
    const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
    const settings = arena.normalizeSettings({ mode: "triple", groupedSpecialRounds: true });
    const hostCollection = arena.normalizeCollection({ cards: null, forms: null });
    const guestCollection = arena.normalizeCollection({ cards: catalog.map((card) => card.key), forms: null });
    const input = {
      operationId: "accept-invite-1",
      settings,
      host: { name: "Host", collection: hostCollection, tokenHash: tokenHash(hostToken) },
      guest: { name: "Guest", collection: guestCollection, tokenHash: tokenHash(guestToken) },
    };
    const created = arena.createInvitedRoom(input);
    const replay = arena.createInvitedRoom(input);
    expect(replay.roomId).toBe(created.roomId);
    expect(created.hostRoom).toMatchObject({ viewer: "a", phase: "waiting" });
    expect(created.guestRoom).toMatchObject({ viewer: "b", phase: "waiting" });
    expect(arena.getView(created.roomId, hostToken).viewer).toBe("a");
    expect(arena.getView(created.roomId, guestToken).viewer).toBe("b");
    expect(() => arena.createInvitedRoom({ ...input, guest: { ...input.guest, name: "Changed" } })).toThrowError(/operationId was already used/i);
    expect(() => arena.createInvitedRoom({ ...input, operationId: "bad-hash", host: { ...input.host, tokenHash: "A".repeat(64) } })).toThrowError(/lowercase hexadecimal/i);
    arena.close();
    services.splice(services.indexOf(arena), 1);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const rows = database.prepare("SELECT seat, token_hash FROM arena_credentials WHERE room_id = ? ORDER BY seat").all(created.roomId) as Array<{ seat: string; token_hash: string }>;
    database.close();
    expect(rows).toEqual([
      { seat: "a", token_hash: tokenHash(hostToken) },
      { seat: "b", token_hash: tokenHash(guestToken) },
    ]);
    expect(fs.readFileSync(databasePath).includes(Buffer.from(hostToken))).toBe(false);
    expect(fs.readFileSync(databasePath).includes(Buffer.from(guestToken))).toBe(false);
  });

  it("claims one guest seat atomically and stores resumable credentials", () => {
    const arena = service();
    const host = arena.createRoom({ name: "Host", settings: { mode: "mega", poolSize: 36, pickSeconds: 15, specialForms: true, battleMode: "Friendly" } });
    const first = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest" });
    expect(() => arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Intruder" })).toThrowError(/full/i);
    expect(arena.getView(host.credential.roomId, first.credential.token).viewer).toBe("b");
    expect(() => arena.getView(host.credential.roomId, "not-a-token")).toThrowError(/credentials/i);
  });

  it("commits one concurrent revision and makes command replay idempotent", async () => {
    const arena = service();
    const pair = createPair(arena);
    const credential = credentialFor(pair, pair.started.activeSeat as "a" | "b");
    const initial = arena.getView(pair.started.id, credential.token);
    const legal = initial.board.filter((cell) => cell.legalForms.length > 0);
    const firstInput = { cardKey: legal[0]?.cardKey, form: legal[0]?.legalForms[0], commandId: "claim-1", expectedRevision: initial.revision };
    const secondInput = { cardKey: legal[1]?.cardKey, form: legal[1]?.legalForms[0], commandId: "claim-2", expectedRevision: initial.revision };
    const settled = await Promise.allSettled([
      Promise.resolve().then(() => arena.pick(initial.id, credential.token, firstInput)),
      Promise.resolve().then(() => arena.pick(initial.id, credential.token, secondInput)),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    const committed = arena.getView(initial.id, credential.token);
    const replay = arena.pick(initial.id, credential.token, firstInput);
    expect(replay.revision).toBe(committed.revision);
    expect(replay.events).toHaveLength(1);
  });

  it("prepares assets without a running clock and starts only after both loading acknowledgements", () => {
    const arena = service();
    const host = arena.createRoom({ name: "Host", settings: { mode: "mega", poolSize: 36, pickSeconds: 15, specialForms: true, battleMode: "Friendly" } });
    const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest" });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "host-ready" });
    const loading = arena.setReady(host.room.id, guest.credential.token, { ready: true, commandId: "guest-ready" });
    expect(loading).toMatchObject({ phase: "loading", activeSeat: null, interactiveAt: null, deadlineAt: null });
    expect(loading.board).toHaveLength(36);
    expect(loading.board.some((cell) => cell.legalForms.length > 0)).toBe(true);
    const oneLoaded = arena.setLoaded(host.room.id, host.credential.token, { commandId: "host-loaded" });
    expect(oneLoaded.phase).toBe("loading");
    expect(oneLoaded.participants.map((participant) => participant.loaded)).toEqual([true, false]);
    const drafting = arena.setLoaded(host.room.id, guest.credential.token, { commandId: "guest-loaded" });
    expect(drafting.phase).toBe("drafting");
    expect(drafting.activeSeat).toBe("a");
    expect(drafting.interactiveAt).not.toBeNull();
    expect(drafting.deadlineAt).not.toBeNull();
  });

  it("keeps the first pick inactive until the initial deal finishes", () => {
    let timestamp = 1_000;
    const arena = service({ now: () => timestamp, initialDealMs: undefined });
    const host = arena.createRoom({ name: "Host", practice: true });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "deal-ready" });
    const drafting = arena.setLoaded(host.room.id, host.credential.token, { commandId: "deal-loaded" });
    expect(drafting.interactiveAt).toBe(3_400);
    expect(drafting.deadlineAt).toBe(18_400);
    expect(() => arena.pick(host.room.id, host.credential.token, {
      ...firstLegal(drafting),
      commandId: "deal-too-soon",
      expectedRevision: drafting.revision,
    })).toThrowError(/not interactive/i);
    timestamp = 3_400;
    expect(arena.pick(host.room.id, host.credential.token, {
      ...firstLegal(drafting),
      commandId: "deal-on-time",
      expectedRevision: drafting.revision,
    }).events).toHaveLength(1);
  });

  it("uses native timing defaults when the room mode changes", () => {
    const arena = service();
    const mega = arena.createRoom({ name: "Mega" });
    const triple = arena.createRoom({ name: "Triple", settings: { mode: "triple" } });
    const classic = arena.createRoom({ name: "Classic", settings: { mode: "classic" } });
    expect(mega.room.settings).toMatchObject({ mode: "mega", pickSeconds: 15, timerMode: "per_pick", mirrorMode: false });
    expect(triple.room.settings).toMatchObject({ mode: "triple", pickSeconds: 60, timerMode: "whole_draft", mirrorMode: false });
    expect(classic.room.settings).toMatchObject({ mode: "classic", pickSeconds: 60, timerMode: "whole_draft", mirrorMode: false });
    expect(() => arena.createRoom({ name: "Bad Mirror", settings: { mirrorMode: "yes" } })).toThrowError(/mirrorMode must be boolean/i);
  });

  it.each([
    ["mega", 36],
    ["triple", 3],
    ["classic", 2],
  ] as const)("runs %s Mirror with preset Mirror plus seven alternating public picks", (mode, offerSize) => {
    const arena = service();
    const pair = createPairWithSettings(arena, {
      mode,
      mirrorMode: true,
      poolSize: 36,
      pickSeconds: 120,
      timerMode: "per_pick",
      specialForms: true,
      battleMode: "Friendly",
    });
    const hostStart = arena.getView(pair.host.room.id, pair.host.credential.token);
    const guestStart = arena.getView(pair.host.room.id, pair.guest.credential.token);
    expect(hostStart).toMatchObject({ activeSeat: "a", pickNumber: 1, totalPicks: 7 });
    expect(guestStart).toMatchObject({ activeSeat: "a", pickNumber: 1, totalPicks: 7 });
    expect(hostStart.board).toHaveLength(offerSize);
    expect(hostStart.board.every((cell) => cell.cardKey !== "mirror")).toBe(true);
    expect(guestStart.board.map((cell) => cell.cardKey)).toEqual(hostStart.board.map((cell) => cell.cardKey));
    expect(hostStart.board.every((cell) => cell.offeredTo === undefined)).toBe(true);
    expect(hostStart.board.some((cell) => cell.legalForms.length > 0)).toBe(true);
    expect(guestStart.board.every((cell) => cell.legalForms.length === 0)).toBe(true);
    expect(() => arena.pick(pair.host.room.id, pair.guest.credential.token, {
      ...firstLegal(hostStart),
      commandId: `mirror-${mode}-out-of-turn`,
      expectedRevision: guestStart.revision,
    })).toThrowError(/no active pick/i);

    for (const participant of hostStart.participants) {
      expect(participant.deck).toEqual([{ cardKey: "mirror", form: "base", pickedBy: "a", preset: true }]);
    }
    let view = hostStart;
    const offeredKeys = new Set<string>();
    for (let pick = 0; pick < 7; pick += 1) {
      expect(view.activeSeat).toBe(pick % 2 === 0 ? "a" : "b");
      expect(view.board).toHaveLength(offerSize);
      if (mode !== "mega") view.board.forEach((cell) => offeredKeys.add(cell.cardKey));
      const credential = credentialFor(pair, view.activeSeat as "a" | "b");
      view = arena.getView(view.id, credential.token);
      view = arena.pick(view.id, credential.token, {
        ...firstLegal(view),
        commandId: `mirror-${mode}-${pick}`,
        expectedRevision: view.revision,
      });
      const hostView = arena.getView(view.id, pair.host.credential.token);
      const guestView = arena.getView(view.id, pair.guest.credential.token);
      const hostDeck = hostView.participants.find((participant) => participant.seat === "a")?.deck;
      const guestDeck = guestView.participants.find((participant) => participant.seat === "b")?.deck;
      expect(hostDeck).toEqual(guestDeck);
      expect(hostDeck).toHaveLength(pick + 2);
      expect(hostView.events).toEqual(guestView.events);
    }

    const completedHost = arena.getView(pair.host.room.id, pair.host.credential.token);
    const completedGuest = arena.getView(pair.host.room.id, pair.guest.credential.token);
    expect(completedHost).toMatchObject({ phase: "complete", activeSeat: null, pickNumber: 7, totalPicks: 7 });
    expect(completedHost.events.map((event) => event.seat)).toEqual(["a", "b", "a", "b", "a", "b", "a"]);
    if (mode !== "mega") expect(offeredKeys.size).toBe(7 * offerSize);
    expect(completedGuest.participants.map((participant) => participant.deck)).toEqual(completedHost.participants.map((participant) => participant.deck));
    expect(completedGuest.export?.entries).toEqual(completedHost.export?.entries);
    expect(completedHost.export?.entries.filter((entry) => entry.preset)).toEqual([
      expect.objectContaining({ cardKey: "mirror", form: "base", preset: true }),
    ]);
    expect(completedHost.exportError).toBeUndefined();
    expect(completedHost.export?.averageElixir).toBeNull();
  });

  it("presets Mirror outside custom filters and never duplicates it into the offered Mega board", () => {
    const arena = service();
    const offered = catalog.filter((card) => card.key !== "mirror" && card.kind === "troop" && isFixedArenaElixirCost(card.elixir) && card.elixir >= 2).slice(0, 16).map((card) => card.key);
    const pair = createPairWithSettings(arena, {
      mode: "mega",
      mirrorMode: true,
      poolSize: 16,
      pickSeconds: 120,
      specialForms: true,
      battleMode: "Friendly",
      includeCards: offered,
      excludeCards: ["mirror"],
      minElixir: 2,
      cardKinds: ["troop"],
    });
    const hostView = arena.getView(pair.host.room.id, pair.host.credential.token);
    expect(hostView.board.map((cell) => cell.cardKey).sort()).toEqual(offered.sort());
    expect(hostView.board.some((cell) => cell.cardKey === "mirror")).toBe(false);
    expect(hostView.participants.every((participant) => participant.deck.filter((entry) => entry.cardKey === "mirror").length === 1)).toBe(true);
    const completed = completeMirrorPair(arena, pair, "filtered-preset-mirror");
    expect(completed.participants.every((participant) => participant.deck.filter((entry) => entry.cardKey === "mirror").length === 1)).toBe(true);
    expect(completed.export?.entries.filter((entry) => entry.cardKey === "mirror")).toHaveLength(1);
  });

  it("rejects a declared collection that does not own base Mirror before dealing", () => {
    const arena = service();
    const withoutMirror = catalog.slice(0, 24).map((card) => card.key);
    const host = arena.createRoom({
      name: "Host",
      collection: { cards: withoutMirror, forms: null },
      settings: { mode: "mega", mirrorMode: true, poolSize: 16, pickSeconds: 120, specialForms: true, battleMode: "Friendly" },
    });
    const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest" });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "missing-mirror-host-ready" });
    expect(() => arena.setReady(host.room.id, guest.credential.token, {
      ready: true,
      commandId: "missing-mirror-guest-ready",
    })).toThrowError(/both players must own the base Mirror card/i);
  });

  it.each(["mega", "triple", "classic"] as const)("keeps Chaos %s Mirror unseeded with eight shared picks", (mode) => {
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const pair = createPairWithSettings(arena, {
      mode,
      mirrorMode: true,
      poolSize: 36,
      pickSeconds: 120,
      timerMode: "per_pick",
      specialForms: true,
      battleMode: "Chaos Infinite Elixir",
    });
    const started = arena.getView(pair.host.room.id, pair.host.credential.token);
    expect(started.settings).toMatchObject({ mirrorMode: true, battleMode: "Chaos Infinite Elixir", specialForms: false });
    expect(started.totalPicks).toBe(8);
    expect(started.participants.every((participant) => participant.deck.length === 0)).toBe(true);
    expect(started.board.every((cell) => cell.cardKey !== "mirror")).toBe(true);
    const completed = completeMirrorPair(arena, pair, `chaos-unseeded-mirror-${mode}`);
    expect(completed.events).toHaveLength(8);
    expect(completed.participants.every((participant) => participant.deck.length === 8 && participant.deck.every((entry) => !entry.preset && entry.cardKey !== "mirror"))).toBe(true);
    expect(completed.exportError).toBeUndefined();
  });

  it("intersects both players' card and form ownership for Mirror", () => {
    const arena = service();
    const commonCards = catalog.slice(0, 16);
    const evolutionCard = commonCards.find((card) => card.forms.some((form) => form.key === "evolution")) as ArenaCard;
    const pair = createPairWithSettings(arena, {
      mode: "mega",
      mirrorMode: true,
      poolSize: 16,
      pickSeconds: 120,
      specialForms: true,
      battleMode: "Friendly",
    }, {
      host: { cards: [...catalog.slice(0, 24).map((card) => card.key), "mirror"], forms: { [evolutionCard.key]: ["evolution"] } },
      guest: { cards: [...commonCards.map((card) => card.key), "mirror"], forms: { [evolutionCard.key]: [] } },
    });
    const hostView = arena.getView(pair.host.room.id, pair.host.credential.token);
    expect(hostView.board.map((cell) => cell.cardKey).sort()).toEqual(commonCards.map((card) => card.key).sort());
    const cell = hostView.board.find((candidate) => candidate.cardKey === evolutionCard.key);
    expect(cell?.legalForms).toContain("base");
    expect(cell?.legalForms).not.toContain("evolution");
  });

  it.each([
    ["mega", 15],
    ["triple", 20],
    ["classic", 13],
  ] as const)("rejects a %s Mirror deal below its unique common-card requirement", (mode, commonCount) => {
    const arena = service();
    const common = [...catalog.slice(0, commonCount).map((card) => card.key), "mirror"];
    const host = arena.createRoom({
      name: "Host",
      collection: { cards: common, forms: null },
      settings: { mode, mirrorMode: true, poolSize: 36, pickSeconds: 120, specialForms: true, battleMode: "Friendly" },
    });
    const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest", collection: { cards: common, forms: null } });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: `mirror-short-host-${mode}` });
    expect(() => arena.setReady(host.room.id, guest.credential.token, {
      ready: true,
      commandId: `mirror-short-guest-${mode}`,
    })).toThrowError(/commonly owned|shared collection/i);
  });

  it("locks grouped Mirror Triple into preset Mirror, two Evolution, one Hero or Champion, and four base rounds", () => {
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const pair = createPairWithSettings(arena, {
      mode: "triple",
      mirrorMode: true,
      groupedSpecialRounds: true,
      poolSize: 36,
      pickSeconds: 120,
      timerMode: "whole_draft",
      specialForms: true,
      battleMode: "Friendly",
    });
    const hostStart = arena.getView(pair.host.room.id, pair.host.credential.token);
    const guestStart = arena.getView(pair.host.room.id, pair.guest.credential.token);
    expect(hostStart.currentRound).toMatchObject({ roundNumber: 1, kind: "evolution", remainingSpecialRounds: 3 });
    expect(hostStart.board.every((cell) => cell.displayForm === "evolution" && cell.legalForms[0] === "evolution")).toBe(true);
    expect(guestStart.board.every((cell) => cell.displayForm === "evolution" && cell.legalForms.length === 0)).toBe(true);
    const completed = completeMirrorPair(arena, pair, "grouped-mirror");
    const decks = completed.participants.map((participant) => participant.deck);
    expect(decks[0]).toEqual(decks[1]);
    expect(decks[0]?.map((entry) => entry.form)).toEqual([
      "base", "evolution", "evolution", expect.stringMatching(/hero|champion/), "base", "base", "base", "base",
    ]);
    expect(decks[0]?.[0]).toMatchObject({ cardKey: "mirror", form: "base", preset: true });
    expect(completed.currentRound).toBeUndefined();
    expect(completed.roundSchedule).toEqual(["evolution", "evolution", "hero_champion", "base", "base", "base", "base"]);
  });

  it("uses one whole-draft timeout to auto-fill all seven alternating Mirror turns", () => {
    let timestamp = 1_000;
    const arena = service({ now: () => timestamp });
    const host = arena.createRoom({
      name: "Host",
      practice: true,
      settings: { mode: "classic", mirrorMode: true, poolSize: 36, pickSeconds: 1, timerMode: "whole_draft", specialForms: true, battleMode: "Friendly" },
    });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "mirror-timeout-ready" });
    const started = arena.setLoaded(host.room.id, host.credential.token, { commandId: "mirror-timeout-loaded" });
    expect(started).toMatchObject({ activeSeat: "a", deadlineAt: 2_000, totalPicks: 7 });
    timestamp = 2_000;
    expect(() => arena.pick(host.room.id, host.credential.token, {
      ...firstLegal(started),
      commandId: "mirror-timeout-expired",
      expectedRevision: started.revision,
    })).toThrowError(/automatic pick was committed/i);
    const completed = arena.getView(host.room.id, host.credential.token);
    expect(completed.phase).toBe("complete");
    expect(completed.events).toHaveLength(7);
    expect(completed.events.map((event) => event.seat)).toEqual(["a", "b", "a", "b", "a", "b", "a"]);
    expect(completed.events.every((event) => event.automatic && event.at === 2_000)).toBe(true);
    expect(completed.participants[0]?.deck).toEqual(completed.participants[1]?.deck);
    expect(completed.participants[0]?.deck).toHaveLength(8);
  });

  it("commits the authoritative active Mirror seat when an inactive viewer arrives after a per-pick deadline", () => {
    let timestamp = 1_000;
    const arena = service({ now: () => timestamp });
    const pair = createPairWithSettings(arena, {
      mode: "classic",
      mirrorMode: true,
      poolSize: 36,
      pickSeconds: 1,
      timerMode: "per_pick",
      specialForms: true,
      battleMode: "Friendly",
    });
    const activeView = arena.getView(pair.host.room.id, pair.host.credential.token);
    const inactiveView = arena.getView(pair.host.room.id, pair.guest.credential.token);
    expect(activeView.activeSeat).toBe("a");
    timestamp = 2_000;
    expect(() => arena.pick(pair.host.room.id, pair.guest.credential.token, {
      ...firstLegal(activeView),
      commandId: "mirror-inactive-after-deadline",
      expectedRevision: inactiveView.revision,
    })).toThrowError(/automatic pick was committed/i);
    const committed = arena.getView(pair.host.room.id, pair.host.credential.token);
    expect(committed.events).toHaveLength(1);
    expect(committed.events[0]).toMatchObject({ seat: "a", automatic: true, at: 2_000 });
    expect(committed.activeSeat).toBe("b");
    expect(committed.participants[0]?.deck).toEqual(committed.participants[1]?.deck);
  });

  it("persists a shared Mirror offer lane across restart and retains it for rematch", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arena-mirror-restart-"));
    tempRoots.push(tempRoot);
    const databasePath = path.join(tempRoot, "arena.sqlite");
    let arena = service({ databasePath });
    const pair = createPairWithSettings(arena, {
      mode: "triple",
      mirrorMode: true,
      poolSize: 36,
      pickSeconds: 120,
      timerMode: "per_pick",
      specialForms: true,
      battleMode: "Friendly",
    });
    const first = arena.getView(pair.host.room.id, pair.host.credential.token);
    const afterFirst = arena.pick(first.id, pair.host.credential.token, {
      ...firstLegal(first),
      commandId: "mirror-before-restart",
      expectedRevision: first.revision,
    });
    const persistedOffer = afterFirst.board.map((cell) => cell.cardKey);
    expect(afterFirst.activeSeat).toBe("b");
    arena.close();
    services.splice(services.indexOf(arena), 1);

    arena = service({ databasePath, catalog: catalog.slice().reverse(), catalogVersion: "replacement" });
    const resumedHost = arena.getView(pair.host.room.id, pair.host.credential.token);
    const resumedGuest = arena.getView(pair.host.room.id, pair.guest.credential.token);
    expect(resumedHost).toMatchObject({ activeSeat: "b", pickNumber: 2, totalPicks: 7 });
    expect(resumedHost.board.map((cell) => cell.cardKey)).toEqual(persistedOffer);
    expect(resumedGuest.board.map((cell) => cell.cardKey)).toEqual(persistedOffer);
    expect(resumedHost.participants[0]?.deck).toEqual(resumedHost.participants[1]?.deck);
    expect(resumedGuest.board.some((cell) => cell.legalForms.length > 0)).toBe(true);

    let view = resumedGuest;
    for (let pick = 1; pick < 7; pick += 1) {
      const credential = credentialFor(pair, view.activeSeat as "a" | "b");
      view = arena.getView(view.id, credential.token);
      view = arena.pick(view.id, credential.token, {
        ...firstLegal(view),
        commandId: `mirror-after-restart-${pick}`,
        expectedRevision: view.revision,
      });
    }
    expect(view.phase).toBe("complete");
    const waiting = arena.rematch(view.id, pair.host.credential.token, { commandId: "mirror-rematch" });
    expect(waiting).toMatchObject({ phase: "waiting", totalPicks: 7, settings: { mirrorMode: true } });
    expect(waiting.board).toEqual([]);
    expect(waiting.events).toEqual([]);
    arena.setReady(view.id, pair.host.credential.token, { ready: true, commandId: "mirror-rematch-host-ready" });
    const loading = arena.setReady(view.id, pair.guest.credential.token, { ready: true, commandId: "mirror-rematch-guest-ready" });
    expect(loading.board).toHaveLength(3);
    expect(loading.board.every((cell) => cell.offeredTo === undefined)).toBe(true);
    expect(loading.participants.every((participant) => participant.deck[0]?.preset === true)).toBe(true);
  });

  it("preserves an active legacy non-Chaos Mirror room as eight unseeded picks", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arena-legacy-unseeded-mirror-"));
    tempRoots.push(tempRoot);
    const databasePath = path.join(tempRoot, "arena.sqlite");
    let arena = service({ databasePath, catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const pair = createPairWithSettings(arena, {
      mode: "classic",
      mirrorMode: true,
      poolSize: 36,
      pickSeconds: 120,
      timerMode: "per_pick",
      specialForms: true,
      battleMode: "Chaos Infinite Elixir",
    });
    const first = arena.getView(pair.host.room.id, pair.host.credential.token);
    const afterFirst = arena.pick(first.id, pair.host.credential.token, {
      ...firstLegal(first),
      commandId: "legacy-unseeded-first",
      expectedRevision: first.revision,
    });
    expect(afterFirst).toMatchObject({ activeSeat: "b", totalPicks: 8 });
    expect(afterFirst.participants.every((participant) => participant.deck.every((entry) => !entry.preset))).toBe(true);
    arena.close();
    services.splice(services.indexOf(arena), 1);

    const inspection = new DatabaseSync(databasePath);
    const row = inspection.prepare("SELECT state_json FROM arena_rooms WHERE id = ?").get(first.id) as { state_json: string };
    const state = JSON.parse(row.state_json) as { settings: ArenaSettings };
    state.settings.battleMode = "Friendly 1v1";
    inspection.prepare("UPDATE arena_rooms SET state_json = ? WHERE id = ?").run(JSON.stringify(state), first.id);
    inspection.close();

    arena = service({ databasePath, catalog: realCatalogPayload.cards, catalogVersion: "replacement" });
    let resumed = arena.getView(first.id, pair.guest.credential.token);
    expect(resumed).toMatchObject({ phase: "drafting", activeSeat: "b", totalPicks: 8, settings: { battleMode: "Friendly 1v1" } });
    expect(resumed.participants.every((participant) => participant.deck.every((entry) => !entry.preset))).toBe(true);
    for (let pick = 1; pick < 8; pick += 1) {
      const credential = credentialFor(pair, resumed.activeSeat as "a" | "b");
      resumed = arena.getView(first.id, credential.token);
      resumed = arena.pick(first.id, credential.token, {
        ...firstLegal(resumed),
        commandId: `legacy-unseeded-${pick}`,
        expectedRevision: resumed.revision,
      });
    }
    expect(resumed.phase).toBe("complete");
    expect(resumed.events).toHaveLength(8);
    expect(resumed.participants.every((participant) => participant.deck.length === 8 && participant.deck.every((entry) => !entry.preset))).toBe(true);
    expect(resumed.exportError).toBeUndefined();
  });

  it("resumes a pending Mirror bot turn and commits through the same shared lane", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arena-mirror-bot-restart-"));
    tempRoots.push(tempRoot);
    const databasePath = path.join(tempRoot, "arena.sqlite");
    let arena = service({ databasePath, botDelayMs: 10 });
    const host = arena.createRoom({
      name: "Host",
      practice: true,
      settings: { mode: "triple", mirrorMode: true, poolSize: 36, pickSeconds: 120, timerMode: "per_pick", specialForms: true, battleMode: "Friendly" },
    });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "mirror-bot-ready" });
    const started = arena.setLoaded(host.room.id, host.credential.token, { commandId: "mirror-bot-loaded" });
    const afterHost = arena.pick(host.room.id, host.credential.token, {
      ...firstLegal(started),
      commandId: "mirror-bot-host-pick",
      expectedRevision: started.revision,
    });
    expect(afterHost.activeSeat).toBe("b");
    arena.close();
    services.splice(services.indexOf(arena), 1);

    arena = service({ databasePath, botDelayMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resumed = arena.getView(host.room.id, host.credential.token);
    expect(resumed.events).toHaveLength(2);
    expect(resumed.events[1]).toMatchObject({ seat: "b", automatic: true });
    expect(resumed.activeSeat).toBe("a");
    expect(resumed.participants[0]?.deck).toEqual(resumed.participants[1]?.deck);
  });

  it("commits only one concurrent Mirror claim and duplicates it into both decks", async () => {
    const arena = service();
    const pair = createPairWithSettings(arena, {
      mode: "classic",
      mirrorMode: true,
      poolSize: 36,
      pickSeconds: 120,
      timerMode: "per_pick",
      specialForms: true,
      battleMode: "Friendly",
    });
    const initial = arena.getView(pair.host.room.id, pair.host.credential.token);
    const legal = initial.board.filter((cell) => cell.legalForms.length > 0);
    expect(legal).toHaveLength(2);
    const settled = await Promise.allSettled(legal.map((cell, index) => Promise.resolve().then(() => arena.pick(initial.id, pair.host.credential.token, {
      cardKey: cell.cardKey,
      form: cell.legalForms[0],
      commandId: `mirror-concurrent-${index}`,
      expectedRevision: initial.revision,
    }))));
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    const committed = arena.getView(initial.id, pair.host.credential.token);
    expect(committed.events).toHaveLength(1);
    expect(committed.participants[0]?.deck).toEqual(committed.participants[1]?.deck);
    expect(committed.participants[0]?.deck).toHaveLength(2);
  });

  it("creates social invited Mirror rooms through the internal hashed-token bridge", () => {
    const arena = service();
    const hostToken = "mirror-social-host-token";
    const guestToken = "mirror-social-guest-token";
    const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
    const invited = arena.createInvitedRoom({
      operationId: "mirror-social-operation",
      settings: arena.normalizeSettings({ mode: "classic", mirrorMode: true }),
      host: { name: "Host", collection: arena.normalizeCollection(null), tokenHash: tokenHash(hostToken) },
      guest: { name: "Guest", collection: arena.normalizeCollection(null), tokenHash: tokenHash(guestToken) },
    });
    expect(invited.hostRoom.settings.mirrorMode).toBe(true);
    arena.setReady(invited.roomId, hostToken, { ready: true, commandId: "mirror-social-host-ready" });
    const loading = arena.setReady(invited.roomId, guestToken, { ready: true, commandId: "mirror-social-guest-ready" });
    expect(loading).toMatchObject({ phase: "loading", totalPicks: 7 });
    expect(loading.board).toHaveLength(2);
    expect(loading.board.every((cell) => cell.offeredTo === undefined)).toBe(true);
    expect(loading.participants.every((participant) => participant.deck[0]?.preset === true)).toBe(true);
  });

  it("fails grouped Mirror Triple clearly when the common collections expose no special forms", () => {
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const baseOnly = { cards: null, forms: {} };
    const host = arena.createRoom({
      name: "Host",
      collection: baseOnly,
      settings: { mode: "triple", mirrorMode: true, groupedSpecialRounds: true, specialForms: true },
    });
    const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest", collection: baseOnly });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "mirror-group-short-host" });
    expect(() => arena.setReady(host.room.id, guest.credential.token, {
      ready: true,
      commandId: "mirror-group-short-guest",
    })).toThrowError(/form-compatible offer cards/i);
  });

  it("keeps one private whole-draft deadline and atomically timestamps the bounded timeout fill", () => {
    let timestamp = 1_000;
    const arena = service({ now: () => timestamp });
    const host = arena.createRoom({
      name: "Host",
      settings: { mode: "triple", poolSize: 36, pickSeconds: 1, timerMode: "whole_draft", specialForms: true, battleMode: "Friendly" },
    });
    const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest" });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "whole-host-ready" });
    arena.setReady(host.room.id, guest.credential.token, { ready: true, commandId: "whole-guest-ready" });
    arena.setLoaded(host.room.id, host.credential.token, { commandId: "whole-host-loaded" });
    const started = arena.setLoaded(host.room.id, guest.credential.token, { commandId: "whole-guest-loaded" });
    expect(started.deadlineAt).toBe(2_000);
    timestamp = 1_200;
    const hostView = arena.getView(host.room.id, host.credential.token);
    const afterHost = arena.pick(host.room.id, host.credential.token, {
      ...firstLegal(hostView),
      commandId: "whole-host-pick",
      expectedRevision: hostView.revision,
    });
    expect(afterHost.deadlineAt).toBe(2_000);
    const guestView = arena.getView(host.room.id, guest.credential.token);
    expect(guestView.deadlineAt).toBe(2_000);
    timestamp = 2_000;
    expect(() => arena.pick(host.room.id, guest.credential.token, {
      ...firstLegal(guestView),
      commandId: "whole-too-late",
      expectedRevision: guestView.revision,
    })).toThrowError(/automatic pick was committed/i);
    const completed = arena.getView(host.room.id, host.credential.token);
    expect(completed.phase).toBe("complete");
    expect(completed.participants.map((participant) => participant.deckCount)).toEqual([8, 8]);
    const guestCompleted = arena.getView(host.room.id, guest.credential.token);
    expect(completed.events).toHaveLength(8);
    expect(guestCompleted.events).toHaveLength(8);
    expect([...completed.events, ...guestCompleted.events].filter((event) => event.automatic)).toHaveLength(15);
    expect(new Set([...completed.events, ...guestCompleted.events].filter((event) => event.automatic).map((event) => event.at))).toEqual(new Set([2_000]));
  });

  it("resets only the completed lane's deadline in private per-pick timing", () => {
    let timestamp = 1_000;
    const arena = service({ now: () => timestamp });
    const host = arena.createRoom({
      name: "Host",
      settings: { mode: "triple", poolSize: 36, pickSeconds: 1, timerMode: "per_pick", specialForms: true, battleMode: "Friendly" },
    });
    const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest" });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "per-host-ready" });
    arena.setReady(host.room.id, guest.credential.token, { ready: true, commandId: "per-guest-ready" });
    arena.setLoaded(host.room.id, host.credential.token, { commandId: "per-host-loaded" });
    const started = arena.setLoaded(host.room.id, guest.credential.token, { commandId: "per-guest-loaded" });
    expect(started.deadlineAt).toBe(2_000);
    timestamp = 1_200;
    const hostView = arena.getView(host.room.id, host.credential.token);
    const next = arena.pick(host.room.id, host.credential.token, {
      ...firstLegal(hostView),
      commandId: "per-host-pick",
      expectedRevision: hostView.revision,
    });
    expect(next.deadlineAt).toBe(2_200);
    expect(arena.getView(host.room.id, guest.credential.token).deadlineAt).toBe(2_000);
  });

  it("returns an expired loading room to waiting without an automatic draft", () => {
    let timestamp = 1_000;
    const arena = service({ now: () => timestamp, loadingTimeoutMs: 60_000 });
    const host = arena.createRoom({ name: "Host", practice: true });
    const loading = arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "ready" });
    expect(loading.phase).toBe("loading");
    timestamp = 61_001;
    expect(() => arena.setLoaded(host.room.id, host.credential.token, { commandId: "too-late" })).toThrowError(/expired/i);
    const waiting = arena.getView(host.room.id, host.credential.token);
    expect(waiting.phase).toBe("waiting");
    expect(waiting.board).toEqual([]);
    expect(waiting.events).toEqual([]);
    expect(waiting.participants.find((participant) => participant.seat === "a")).toMatchObject({ ready: false, loaded: false });
  });

  it("allows a slow cold load within the default three-minute window", () => {
    let timestamp = 1_000;
    const arena = service({ now: () => timestamp });
    const host = arena.createRoom({ name: "Host", practice: true });
    expect(arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "slow-ready" }).phase).toBe("loading");
    timestamp = 75_000;
    expect(arena.setLoaded(host.room.id, host.credential.token, { commandId: "slow-loaded" }).phase).toBe("drafting");
  });

  it("deals only cards allowed by combined semantic pool filters", () => {
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const settings = {
      mode: "mega" as const,
      poolSize: 16,
      pickSeconds: 15,
      specialForms: true,
      battleMode: "Friendly",
      cardKinds: ["troop"],
      rarities: ["rare", "epic"],
      families: ["anti-air", "goblin"],
    };
    const allowed = filterArenaCards(realCatalogPayload.cards, settings).map((card) => card.key).sort();
    expect(allowed).toHaveLength(16);
    const host = arena.createRoom({ name: "Host", practice: true, settings });
    const loading = arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "filtered-ready" });
    expect(loading.board.map((cell) => cell.cardKey).sort()).toEqual(allowed);
  });

  it.each(["mega", "triple", "classic"] as const)("uses the final post-filter pool for %s", (mode) => {
    const arena = service();
    const required = mode === "triple" ? 48 : 16;
    const softPool = catalog.slice(0, required);
    const manuallyRemoved = softPool[0] as ArenaCard;
    const manuallyAdded = catalog[required] as ArenaCard;
    const settings: ArenaSettings = {
      mode,
      poolSize: mode === "mega" ? 16 : 36,
      pickSeconds: 120,
      timerMode: mode === "mega" ? "per_pick" : "whole_draft",
      specialForms: true,
      battleMode: "Friendly",
      includeCards: softPool.map((card) => card.key),
      includedCardIds: [manuallyAdded.id],
      excludedCardIds: [manuallyRemoved.id],
    };
    const expected = filterArenaCards(catalog, settings);
    expect(expected).toHaveLength(required);
    expect(expected.some((card) => card.id === manuallyAdded.id)).toBe(true);
    expect(expected.some((card) => card.id === manuallyRemoved.id)).toBe(false);

    const pair = createPairWithSettings(arena, settings);
    expect(pair.loading.settings).toMatchObject({
      includedCardIds: [manuallyAdded.id],
      excludedCardIds: [manuallyRemoved.id],
    });
    const expectedKeys = new Set(expected.map((card) => card.key));
    const seen = new Set<string>();
    for (const credential of [pair.host.credential, pair.guest.credential]) {
      const view = arena.getView(pair.host.room.id, credential.token);
      view.board.forEach((cell) => seen.add(cell.cardKey));
      expect(view.board.every((cell) => expectedKeys.has(cell.cardKey))).toBe(true);
    }
    if (mode === "mega") expect(seen).toEqual(expectedKeys);
    expect(seen.has(manuallyRemoved.key)).toBe(false);
  });

  it("rejects unknown or malformed override ids", () => {
    const arena = service();
    expect(() => arena.createRoom({ name: "Host", settings: { includedCardIds: [99_999_999] } })).toThrowError(/unknown card id/i);
    expect(() => arena.createRoom({ name: "Host", settings: { excludedCardIds: [catalog[0]!.id.toString()] } })).toThrowError(/positive integer card ids/i);
  });

  it("manual additions cannot bypass a player's declared collection", () => {
    const arena = service();
    const owned = catalog.slice(0, 16);
    const unowned = catalog[16] as ArenaCard;
    const settings: ArenaSettings = {
      ...arena.normalizeSettings({ mode: "mega", poolSize: 16 }),
      includeCards: owned.map((card) => card.key),
      includedCardIds: [unowned.id],
    };
    const collection = { cards: owned.map((card) => card.key), forms: null };
    const pair = createPairWithSettings(arena, settings, { host: collection, guest: collection });
    expect(pair.loading.board).toHaveLength(16);
    expect(pair.loading.board.some((cell) => cell.cardKey === unowned.key)).toBe(false);
    expect(pair.loading.board.every((cell) => collection.cards.includes(cell.cardKey))).toBe(true);
  });

  it("never deals a Champion-only dead cell when special forms are disabled", () => {
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const host = arena.createRoom({
      name: "Host",
      practice: true,
      settings: { mode: "mega", poolSize: 36, pickSeconds: 15, specialForms: false, battleMode: "Friendly" },
    });
    const loading = arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "base-only-ready" });
    expect(loading.board).toHaveLength(36);
    expect(loading.board.every((cell) => {
      const card = realCatalogPayload.cards.find((candidate) => candidate.key === cell.cardKey);
      return card?.forms.some((form) => form.key === "base");
    })).toBe(true);
  });

  it.each([
    ["cardKinds", "vehicle"],
    ["rarities", "mythic"],
    ["families", "not-a-family"],
  ] as const)("rejects unknown %s filter values", (field, unknownValue) => {
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    expect(() => arena.createRoom({ name: "Host", settings: { [field]: [unknownValue] } })).toThrowError(/unknown value/i);
  });

  it("preserves omitted filters and clears explicit null filters back to any", () => {
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const initiallyAllowed = realCatalogPayload.cards.filter((card) => card.kind === "troop" && card.rarity === "rare" && card.families.includes("anti-air"));
    const host = arena.createRoom({
      name: "Host",
      practice: true,
      settings: {
        mode: "mega",
        poolSize: 36,
        minElixir: 3,
        maxElixir: 6,
        includeCards: initiallyAllowed.map((card) => card.key),
        excludeCards: [realCatalogPayload.cards[0]?.key],
        includedCardIds: [realCatalogPayload.cards[1]!.id],
        excludedCardIds: [realCatalogPayload.cards[2]!.id],
        cardKinds: ["troop"],
        rarities: ["rare"],
        families: ["anti-air"],
      },
    });
    const preserved = arena.setSettings(host.room.id, host.credential.token, {
      settings: { battleMode: "Preserved partial update" },
      commandId: "preserve-filters",
    });
    expect(preserved.settings).toMatchObject({
      minElixir: 3,
      maxElixir: 6,
      includeCards: initiallyAllowed.map((card) => card.key),
      includedCardIds: [realCatalogPayload.cards[1]!.id],
      excludedCardIds: [realCatalogPayload.cards[2]!.id],
      cardKinds: ["troop"],
      rarities: ["rare"],
      families: ["anti-air"],
    });
    const cleared = arena.setSettings(host.room.id, host.credential.token, {
      settings: {
        minElixir: null,
        maxElixir: null,
        includeCards: null,
        excludeCards: null,
        includedCardIds: null,
        excludedCardIds: null,
        cardKinds: null,
        rarities: null,
        families: null,
      },
      commandId: "clear-filters",
    });
    for (const field of ["minElixir", "maxElixir", "includeCards", "excludeCards", "includedCardIds", "excludedCardIds", "cardKinds", "rarities", "families"]) {
      expect(cleared.settings).not.toHaveProperty(field);
    }
    expect(filterArenaCards(realCatalogPayload.cards, cleared.settings)).toHaveLength(realCatalogPayload.cards.length);
    const loading = arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "cleared-ready" });
    expect(loading.board).toHaveLength(36);
    expect(loading.board.some((cell) => !initiallyAllowed.some((card) => card.key === cell.cardKey))).toBe(true);
  });

  it("persists semantic filters with the room's catalog snapshot", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arena-filter-persistence-"));
    tempRoots.push(tempRoot);
    const databasePath = path.join(tempRoot, "arena.sqlite");
    let arena = service({ databasePath, catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const includedCardIds = [realCatalogPayload.cards[1]!.id];
    const excludedCardIds = [realCatalogPayload.cards[2]!.id];
    const host = arena.createRoom({ name: "Host", settings: { cardKinds: ["troop"], rarities: ["epic"], families: ["anti-air"], includedCardIds, excludedCardIds } });
    arena.close();
    services.splice(services.indexOf(arena), 1);
    arena = service({ databasePath, catalog, catalogVersion: "replacement" });
    const resumed = arena.getView(host.room.id, host.credential.token);
    expect(resumed.catalogVersion).toBe(realCatalogPayload.version);
    expect(resumed.settings).toMatchObject({ cardKinds: ["troop"], rarities: ["epic"], families: ["anti-air"], includedCardIds, excludedCardIds });
    expect(arena.getRoomCatalog(host.room.id, host.credential.token).cards).toEqual(realCatalogPayload.cards);
  });

  it.each(["mega", "triple", "classic"] as const)("restricts every %s Chaos offer and completed export to supported identities", (mode) => {
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const settings: ArenaSettings = {
      mode,
      poolSize: 36,
      pickSeconds: 120,
      timerMode: mode === "mega" ? "per_pick" : "whole_draft",
      specialForms: true,
      battleMode: "Chaos Infinite Elixir",
    };
    const pair = createPairWithSettings(arena, settings);
    const assertSupported = (cardKey: string) => {
      const card = realCatalogPayload.cards.find((candidate) => candidate.key === cardKey);
      expect(card && isChaosSupportedCard(card)).toBe(true);
    };
    expect(pair.loading.board.length).toBeGreaterThan(0);
    pair.loading.board.forEach((cell) => assertSupported(cell.cardKey));
    const completed = completePair(arena, pair, `chaos-${mode}`);
    expect(completed.phase).toBe("complete");
    for (const credential of [pair.host.credential, pair.guest.credential]) {
      const view = arena.getView(pair.host.room.id, credential.token);
      const own = view.participants.find((participant) => participant.seat === credential.seat)?.deck ?? [];
      expect(own).toHaveLength(8);
      own.forEach((entry) => assertSupported(entry.cardKey));
      expect(own.every((entry) => entry.form === "base")).toBe(true);
      expect(view.exportError).toBeUndefined();
      expect(view.export?.entries).toHaveLength(8);
      view.export?.entries.forEach((entry) => assertSupported(entry.cardKey));
    }
  });

  it("composes Chaos with semantic filters and per-seat collections without padding outside the intersection", () => {
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const settings: ArenaSettings = {
      mode: "mega",
      poolSize: 36,
      pickSeconds: 120,
      specialForms: true,
      battleMode: "Chaos friendly battle",
      families: ["anti-air"],
    };
    const allowed = filterArenaCards(realCatalogPayload.cards, settings);
    expect(allowed.length).toBeGreaterThanOrEqual(16);
    expect(allowed.every(isChaosSupportedCard)).toBe(true);
    const pair = createPairWithSettings(arena, settings, {
      host: { cards: allowed.slice(0, Math.ceil(allowed.length / 2)).map((card) => card.key), forms: null },
      guest: { cards: allowed.slice(Math.ceil(allowed.length / 2)).map((card) => card.key), forms: null },
    });
    expect(pair.loading.settings.poolSize).toBe(36);
    expect(pair.loading.board).toHaveLength(allowed.length);
    expect(pair.loading.board.map((cell) => cell.cardKey).sort()).toEqual(allowed.map((card) => card.key).sort());
  });

  it("normalizes Infinite Elixir Triple to base-only and disables grouped special rounds", () => {
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const pair = createPairWithSettings(arena, {
      mode: "triple",
      poolSize: 36,
      pickSeconds: 120,
      timerMode: "whole_draft",
      specialForms: true,
      groupedSpecialRounds: true,
      battleMode: "Chaos Infinite Elixir",
    });
    expect(pair.loading.settings.specialForms).toBe(false);
    expect(pair.loading.settings.groupedSpecialRounds).toBe(false);
    expect(pair.loading.roundSchedule).toBeUndefined();
    expect(pair.loading.board.every((cell) => {
      const card = realCatalogPayload.cards.find((candidate) => candidate.key === cell.cardKey);
      return !!card && isChaosSupportedCard(card) && cell.legalForms.every((form) => form === "base");
    })).toBe(true);
    const complete = completePair(arena, pair, "chaos-grouped");
    expect(complete.exportError).toBeUndefined();
    expect(complete.export?.entries.every((entry) => entry.form === "base")).toBe(true);
  });

  it.each(["mega", "triple", "classic"] as const)("rejects a filtered Chaos %s pool that cannot deal instead of adding unsupported cards", (mode) => {
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const includeCards = realCatalogPayload.cards.filter(isChaosSupportedCard).slice(0, 15).map((card) => card.key);
    const settings: ArenaSettings = {
      mode,
      poolSize: 36,
      pickSeconds: 120,
      specialForms: true,
      battleMode: "Chaos Infinite Elixir",
      includeCards,
    };
    const host = arena.createRoom({ name: "Host", settings });
    const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest" });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: `chaos-short-host-${mode}` });
    expect(() => arena.setReady(host.room.id, guest.credential.token, {
      ready: true,
      commandId: `chaos-short-guest-${mode}`,
    })).toThrowError(/at least sixteen|at least 48|offer|shared cards|eligible cards/i);
  });

  it("applies Chaos to invited rooms, waiting settings updates, and rematches", () => {
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const hostToken = "social-host-room-token";
    const guestToken = "social-guest-room-token";
    const invited = arena.createInvitedRoom({
      operationId: "chaos-social-room",
      settings: arena.normalizeSettings({ mode: "mega", battleMode: "Chaos Infinite Elixir" }),
      host: { name: "Host", collection: arena.normalizeCollection(null), tokenHash: hash(hostToken) },
      guest: { name: "Guest", collection: arena.normalizeCollection(null), tokenHash: hash(guestToken) },
    });
    arena.setReady(invited.roomId, hostToken, { ready: true, commandId: "chaos-invited-host-ready" });
    const invitedLoading = arena.setReady(invited.roomId, guestToken, { ready: true, commandId: "chaos-invited-guest-ready" });
    expect(invitedLoading.board.every((cell) => {
      const card = realCatalogPayload.cards.find((candidate) => candidate.key === cell.cardKey);
      return !!card && isChaosSupportedCard(card);
    })).toBe(true);

    const host = arena.createRoom({ name: "Other Host", settings: { mode: "mega", pickSeconds: 120, battleMode: "Friendly" } });
    const updated = arena.setSettings(host.room.id, host.credential.token, {
      settings: { battleMode: "Chaos Infinite Elixir" },
      commandId: "enable-chaos",
    });
    expect(updated.settings.battleMode).toBe("Chaos Infinite Elixir");
    const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Other Guest" });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "chaos-rematch-host-ready-1" });
    const loading = arena.setReady(host.room.id, guest.credential.token, { ready: true, commandId: "chaos-rematch-guest-ready-1" });
    arena.setLoaded(host.room.id, host.credential.token, { commandId: "chaos-rematch-host-loaded-1" });
    const started = arena.setLoaded(host.room.id, guest.credential.token, { commandId: "chaos-rematch-guest-loaded-1" });
    const pair = { host, guest, loading, started };
    completePair(arena, pair, "chaos-before-rematch");
    const waiting = arena.rematch(host.room.id, host.credential.token, { commandId: "chaos-rematch" });
    expect(waiting.settings.battleMode).toBe("Chaos Infinite Elixir");
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "chaos-rematch-host-ready-2" });
    const nextLoading = arena.setReady(host.room.id, guest.credential.token, { ready: true, commandId: "chaos-rematch-guest-ready-2" });
    expect(nextLoading.board.every((cell) => {
      const card = realCatalogPayload.cards.find((candidate) => candidate.key === cell.cardKey);
      return !!card && isChaosSupportedCard(card);
    })).toBe(true);
  });

  it("normalizes a persisted waiting Infinite room before its first deal", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arena-chaos-waiting-"));
    tempRoots.push(tempRoot);
    const databasePath = path.join(tempRoot, "arena.sqlite");
    let arena = service({ databasePath, catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const host = arena.createRoom({ name: "Host", settings: { mode: "triple", battleMode: "Friendly" } });
    arena.close();
    services.splice(services.indexOf(arena), 1);

    const inspection = new DatabaseSync(databasePath);
    const row = inspection.prepare("SELECT state_json FROM arena_rooms WHERE id = ?").get(host.room.id) as { state_json: string };
    const state = JSON.parse(row.state_json) as { settings: ArenaSettings };
    state.settings = { ...state.settings, battleMode: "Chaos friendly battle", specialForms: true, groupedSpecialRounds: true };
    inspection.prepare("UPDATE arena_rooms SET state_json = ? WHERE id = ?").run(JSON.stringify(state), host.room.id);
    inspection.close();

    arena = service({ databasePath, catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest" });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "legacy-waiting-host" });
    const loading = arena.setReady(host.room.id, guest.credential.token, { ready: true, commandId: "legacy-waiting-guest" });
    expect(loading.settings).toMatchObject({ specialForms: false, groupedSpecialRounds: false });
    expect(loading.roundSchedule).toBeUndefined();
    expect(loading.board.every((cell) => {
      const card = realCatalogPayload.cards.find((candidate) => candidate.key === cell.cardKey);
      return !!card && isChaosSupportedCard(card) && cell.legalForms.every((form) => form === "base");
    })).toBe(true);
  });

  it("preserves a legacy Infinite board but blocks unsupported identity and form exports, then normalizes its rematch", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arena-chaos-active-"));
    tempRoots.push(tempRoot);
    const databasePath = path.join(tempRoot, "arena.sqlite");
    const supported = realCatalogPayload.cards.filter(isChaosSupportedCard).slice(0, 15);
    const outside = realCatalogPayload.cards.find((card) => !isChaosSupportedCard(card) && card.forms.some((form) => form.key === "base")) as ArenaCard;
    let arena = service({ databasePath, catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const pair = createPairWithSettings(arena, {
      mode: "mega",
      poolSize: 16,
      pickSeconds: 120,
      specialForms: true,
      battleMode: "Friendly",
      includeCards: [...supported.map((card) => card.key), outside.key],
    });
    const dealt = pair.started.board.map((cell) => cell.cardKey);
    expect(dealt).toContain(outside.key);
    arena.close();
    services.splice(services.indexOf(arena), 1);
    const inspection = new DatabaseSync(databasePath);
    const row = inspection.prepare("SELECT state_json FROM arena_rooms WHERE id = ?").get(pair.host.room.id) as { state_json: string };
    const state = JSON.parse(row.state_json) as { settings: { battleMode: string } };
    state.settings.battleMode = "Chaos friendly battle";
    inspection.prepare("UPDATE arena_rooms SET state_json = ? WHERE id = ?").run(JSON.stringify(state), pair.host.room.id);
    inspection.close();

    arena = service({ databasePath, catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    expect(arena.getView(pair.host.room.id, pair.host.credential.token).board.map((cell) => cell.cardKey)).toEqual(dealt);
    completePair(arena, pair, "legacy-chaos-active");
    arena.close();
    services.splice(services.indexOf(arena), 1);
    const completedInspection = new DatabaseSync(databasePath);
    const completedRow = completedInspection.prepare("SELECT state_json FROM arena_rooms WHERE id = ?").get(pair.host.room.id) as { state_json: string };
    const completedState = JSON.parse(completedRow.state_json) as { decks: Record<"a" | "b", Array<{ cardKey: string; form: string }>> };
    let specialName = "";
    for (const seat of ["a", "b"] as const) {
      const specialEntry = completedState.decks[seat].find((entry) => realCatalogPayload.cards.find((card) => card.key === entry.cardKey)?.forms.some((form) => form.key === "evolution"));
      if (!specialEntry) continue;
      specialEntry.form = "evolution";
      specialName = realCatalogPayload.cards.find((card) => card.key === specialEntry.cardKey)?.name ?? specialEntry.cardKey;
      break;
    }
    expect(specialName).not.toBe("");
    completedInspection.prepare("UPDATE arena_rooms SET state_json = ? WHERE id = ?").run(JSON.stringify(completedState), pair.host.room.id);
    completedInspection.close();

    arena = service({ databasePath, catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const resumedViews = [pair.host.credential, pair.guest.credential].map((credential) => arena.getView(pair.host.room.id, credential.token));
    expect(resumedViews.flatMap((view) => view.participants.find((participant) => participant.seat === view.viewer)?.deck ?? [])).toHaveLength(16);
    const exportErrors = resumedViews.map((view) => view.exportError ?? "").join(" ");
    expect(exportErrors).toContain(outside.name);
    expect(exportErrors).toContain(specialName);
    expect(exportErrors).toMatch(/current 51-card, base-only rules/i);
    expect(resumedViews.flatMap((view) => view.export?.entries ?? []).map((entry) => entry.cardKey)).not.toContain(outside.key);
    const rematch = arena.rematch(pair.host.room.id, pair.host.credential.token, { commandId: "legacy-chaos-rematch" });
    expect(rematch.settings).toMatchObject({ specialForms: false, groupedSpecialRounds: false });
  });

  it("keeps Triple and Classic offers private and gives the unpicked Classic card", () => {
    for (const mode of ["triple", "classic"] as const) {
      const arena = service();
      const pair = createPair(arena, mode);
      const hostView = arena.getView(pair.started.id, pair.host.credential.token);
      const guestView = arena.getView(pair.started.id, pair.guest.credential.token);
      const hostOwnOffer = hostView.board.filter((cell) => cell.offeredTo === "a");
      const guestOwnOffer = guestView.board.filter((cell) => cell.offeredTo === "b");
      expect(hostOwnOffer).toHaveLength(mode === "triple" ? 3 : 2);
      expect(guestOwnOffer).toHaveLength(mode === "triple" ? 3 : 2);
      if (mode === "triple") {
        expect(hostView.board.filter((cell) => cell.offeredTo === "b")).toHaveLength(3);
        expect(guestView.board.filter((cell) => cell.offeredTo === "a")).toHaveLength(3);
        expect(hostView.board.filter((cell) => cell.offeredTo === "b").every((cell) => cell.legalForms.length === 0)).toBe(true);
      } else {
        expect(guestView.board.map((cell) => cell.cardKey)).not.toContain(hostOwnOffer[0]?.cardKey);
        expect(hostView.board.map((cell) => cell.cardKey)).not.toContain(guestOwnOffer[0]?.cardKey);
      }
      const hostChoice = firstLegal(hostView);
      const next = arena.pick(hostView.id, pair.host.credential.token, { ...hostChoice, commandId: `${mode}-host-pick`, expectedRevision: hostView.revision });
      const guestBeforeOwnPick = arena.getView(hostView.id, pair.guest.credential.token);
      expect(guestBeforeOwnPick.events).toEqual([]);
      if (mode === "classic") {
        expect(next.events[0]?.received).toBeDefined();
        expect(next.participants.map((participant) => participant.deckCount)).toEqual([1, 1]);
        expect(next.participants.map((participant) => participant.deck.length)).toEqual([1, 1]);
        expect(guestBeforeOwnPick.participants.map((participant) => participant.deckCount)).toEqual([1, 1]);
        expect(guestBeforeOwnPick.participants.map((participant) => participant.deck.length)).toEqual([0, 0]);
      }
      const guestChoice = firstLegal(guestBeforeOwnPick);
      const guestNext = arena.pick(hostView.id, pair.guest.credential.token, {
        ...guestChoice,
        commandId: `${mode}-guest-pick`,
        expectedRevision: guestView.revision,
      });
      expect(guestNext.pickNumber).toBe(2);
    }
  });

  it("locks grouped Triple into two Evolution, one Hero or Champion, and five base rounds", () => {
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const host = arena.createRoom({
      name: "Host",
      settings: { mode: "triple", groupedSpecialRounds: true, poolSize: 36, pickSeconds: 120, specialForms: true, battleMode: "Friendly" },
    });
    const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest" });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "grouped-host-ready" });
    const loading = arena.setReady(host.room.id, guest.credential.token, { ready: true, commandId: "grouped-guest-ready" });
    const schedule = ["evolution", "evolution", "hero_champion", "base", "base", "base", "base", "base"];
    expect(loading.roundSchedule).toEqual(schedule);
    expect(loading.currentRound).toMatchObject({ roundNumber: 1, kind: "evolution", remainingSpecialRounds: 3 });
    arena.setLoaded(host.room.id, host.credential.token, { commandId: "grouped-host-loaded" });
    arena.setLoaded(host.room.id, guest.credential.token, { commandId: "grouped-guest-loaded" });
    for (let round = 0; round < schedule.length; round += 1) {
      for (const [seat, credential] of [["a", host.credential], ["b", guest.credential]] as const) {
        const view = arena.getView(host.room.id, credential.token);
        const expectedKind = schedule[round];
        expect(view.currentRound).toMatchObject({
          roundNumber: round + 1,
          totalRounds: 8,
          kind: expectedKind,
          remainingSpecialRounds: Math.max(0, 3 - round),
        });
        const ownOffer = view.board.filter((cell) => cell.offeredTo === seat);
        const opponentOffer = view.board.filter((cell) => cell.offeredTo !== seat);
        expect(ownOffer).toHaveLength(3);
        expect(opponentOffer).toHaveLength(seat === "b" && round === 7 ? 0 : 3);
        expect(opponentOffer.every((cell) => cell.legalForms.length === 0 && cell.displayForm !== undefined)).toBe(true);
        for (const cell of ownOffer) {
          expect(cell.legalForms).toHaveLength(1);
          expect(cell.displayForm).toBe(cell.legalForms[0]);
          if (expectedKind === "evolution") expect(cell.legalForms).toEqual(["evolution"]);
          else if (expectedKind === "hero_champion") expect(["hero", "champion"]).toContain(cell.legalForms[0]);
          else expect(cell.legalForms).toEqual(["base"]);
        }
        arena.pick(host.room.id, credential.token, {
          ...firstLegal(view),
          commandId: `grouped-${seat}-${round}`,
          expectedRevision: view.revision,
        });
      }
    }
    for (const credential of [host.credential, guest.credential]) {
      const completed = arena.getView(host.room.id, credential.token);
      const own = completed.participants.find((participant) => participant.seat === credential.seat);
      const opponent = completed.participants.find((participant) => participant.seat !== credential.seat);
      expect(completed.phase).toBe("complete");
      expect(completed.roundSchedule).toEqual(schedule);
      expect(completed.currentRound).toBeUndefined();
      expect(own?.deck.map((entry) => entry.form)).toEqual([
        "evolution", "evolution", expect.stringMatching(/hero|champion/), "base", "base", "base", "base", "base",
      ]);
      expect(opponent).toMatchObject({ deck: [], deckCount: 8 });
      expect(completed.events).toHaveLength(8);
      expect(completed.export?.entries).toHaveLength(8);
    }
  });

  it("fails grouped Triple explicitly when a collection lacks special forms", () => {
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const host = arena.createRoom({
      name: "Host",
      settings: { mode: "triple", groupedSpecialRounds: true },
      collection: { cards: null, forms: {}, source: "manual" },
    });
    const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest" });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "short-grouped-host" });
    expect(() => arena.setReady(host.room.id, guest.credential.token, {
      ready: true,
      commandId: "short-grouped-guest",
    })).toThrowError(/Grouped Triple requires enough owned/i);
  });

  it("normalizes grouped rounds off outside special-form Triple", () => {
    const arena = service();
    expect(arena.createRoom({ name: "Mega", settings: { mode: "mega", groupedSpecialRounds: true } }).room.settings.groupedSpecialRounds).toBe(false);
    expect(arena.createRoom({ name: "Classic", settings: { mode: "classic", groupedSpecialRounds: true } }).room.settings.groupedSpecialRounds).toBe(false);
    expect(arena.createRoom({ name: "Base Triple", settings: { mode: "triple", specialForms: false, groupedSpecialRounds: true } }).room.settings.groupedSpecialRounds).toBe(false);
    expect(() => arena.createRoom({ name: "Invalid", settings: { mode: "triple", groupedSpecialRounds: "yes" } })).toThrowError(/must be boolean/i);
  });

  it("rejects an unowned form while retaining base as an alternate", () => {
    const arena = service();
    const host = arena.createRoom({
      name: "Host",
      settings: { mode: "mega", poolSize: 36, pickSeconds: 120, specialForms: true, battleMode: "Friendly" },
      collection: { cards: null, forms: {}, source: "api" },
    });
    const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest" });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "host-ready" });
    arena.setReady(host.room.id, guest.credential.token, { ready: true, commandId: "guest-ready" });
    arena.setLoaded(host.room.id, host.credential.token, { commandId: "host-loaded" });
    const view = arena.setLoaded(host.room.id, guest.credential.token, { commandId: "guest-loaded" });
    expect(view.participants.find((participant) => participant.seat === "a")?.collectionSource).toBe("manual");
    const hostView = arena.getView(host.room.id, host.credential.token);
    expect(hostView.board.every((cell) => cell.legalForms.every((form) => form === "base"))).toBe(true);
    const evolved = hostView.board.find((cell) => catalog.find((card) => card.key === cell.cardKey)?.forms.some((form) => form.key === "evolution"));
    expect(evolved).toBeDefined();
    expect(() => arena.pick(host.room.id, host.credential.token, {
      cardKey: evolved?.cardKey,
      form: "evolution",
      commandId: "unowned-evo",
      expectedRevision: hostView.revision,
    })).toThrowError(/cannot preserve/i);
  });

  it("completes a constrained 16-cell Mega pool without a dead end", () => {
    const arena = service();
    const pair = createPair(arena, "mega", 16);
    let view = pair.started;
    for (let pick = 0; pick < 16; pick += 1) {
      const seat = view.activeSeat as "a" | "b";
      const credential = credentialFor(pair, seat);
      view = arena.getView(view.id, credential.token);
      const choice = firstLegal(view);
      view = arena.pick(view.id, credential.token, { ...choice, commandId: `pick-${pick}`, expectedRevision: view.revision });
    }
    expect(view.phase).toBe("complete");
    expect(view.participants.map((participant) => participant.deckCount)).toEqual([8, 8]);
    expect(view.export?.entries).toHaveLength(8);
  });

  it.each([16, 17])("completes two legal decks when a default-cap Mega pool shrinks to %s cards", (eligibleCount) => {
    const arena = service();
    const included = catalog.slice(0, eligibleCount).map((card) => card.key);
    const host = arena.createRoom({
      name: "Host",
      settings: { mode: "mega", poolSize: 36, pickSeconds: 120, specialForms: true, battleMode: "Friendly", includeCards: included },
    });
    const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest" });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: `shrink-${eligibleCount}-host-ready` });
    const loading = arena.setReady(host.room.id, guest.credential.token, { ready: true, commandId: `shrink-${eligibleCount}-guest-ready` });
    expect(loading.settings.poolSize).toBe(36);
    expect(loading.board).toHaveLength(eligibleCount);
    arena.setLoaded(host.room.id, host.credential.token, { commandId: `shrink-${eligibleCount}-host-loaded` });
    let view = arena.setLoaded(host.room.id, guest.credential.token, { commandId: `shrink-${eligibleCount}-guest-loaded` });
    for (let pick = 0; pick < 16; pick += 1) {
      const credential = view.activeSeat === "a" ? host.credential : guest.credential;
      view = arena.getView(view.id, credential.token);
      view = arena.pick(view.id, credential.token, { ...firstLegal(view), commandId: `shrink-${eligibleCount}-${pick}`, expectedRevision: view.revision });
    }
    expect(view.phase).toBe("complete");
    expect(view.participants.map((participant) => participant.deckCount)).toEqual([8, 8]);
  });

  it.each([
    { label: "a filtered 23-card catalog under the default cap", poolSize: 36, eligibleCount: 23, expected: 23 },
    { label: "an explicit 16-card cap", poolSize: 16, eligibleCount: catalog.length, expected: 16 },
    { label: "an odd 23-card cap", poolSize: 23, eligibleCount: catalog.length, expected: 23 },
  ])("deals $label", ({ poolSize, eligibleCount, expected }) => {
    const arena = service();
    const host = arena.createRoom({
      name: "Host",
      practice: true,
      settings: {
        mode: "mega",
        poolSize,
        pickSeconds: 15,
        specialForms: true,
        battleMode: "Friendly",
        ...(eligibleCount < catalog.length ? { includeCards: catalog.slice(0, eligibleCount).map((card) => card.key) } : {}),
      },
    });
    const loading = arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: `cap-${poolSize}-${eligibleCount}` });
    expect(loading.settings.poolSize).toBe(poolSize);
    expect(loading.board).toHaveLength(expected);
  });

  it("blocks a filtered Mega catalog below sixteen eligible cards", () => {
    const arena = service();
    const host = arena.createRoom({
      name: "Host",
      practice: true,
      settings: { mode: "mega", poolSize: 36, includeCards: catalog.slice(0, 15).map((card) => card.key) },
    });
    expect(() => arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "too-small-ready" })).toThrowError(/at least sixteen/i);
  });

  it("normalizes newly supplied legacy Mega caps to thirty-six", () => {
    const arena = service();
    expect(arena.createRoom({ name: "Host", settings: { mode: "mega", poolSize: 48 } }).room.settings.poolSize).toBe(36);
    const host = arena.createRoom({ name: "Other host" });
    expect(arena.setSettings(host.room.id, host.credential.token, { settings: { poolSize: 96 }, commandId: "legacy-cap" }).settings.poolSize).toBe(36);
    expect(() => arena.createRoom({ name: "Invalid", settings: { poolSize: 97 } })).toThrowError(/16 to 96/i);
  });

  it("enforces intrinsic Champions and completes a real-catalog 16-cell pool containing two", () => {
    const championKeys = realCatalogPayload.cards
      .filter((card) => card.forms.some((form) => form.key === "champion") && !card.forms.some((form) => form.key === "base"))
      .slice(0, 2)
      .map((card) => card.key);
    const baseKeys = realCatalogPayload.cards
      .filter((card) => card.forms.some((form) => form.key === "base"))
      .slice(0, 14)
      .map((card) => card.key);
    const included = [...championKeys, ...baseKeys];
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const settings = {
      mode: "mega" as const,
      poolSize: 16,
      pickSeconds: 120,
      specialForms: true,
      battleMode: "Friendly",
      includeCards: included,
    };
    const hostCollection = { cards: [championKeys[0] as string, ...baseKeys.slice(0, 7)], forms: null, source: "manual" };
    const guestCollection = { cards: [championKeys[1] as string, ...baseKeys.slice(7)], forms: null, source: "manual" };
    for (let run = 0; run < 8; run += 1) {
      const host = arena.createRoom({ name: "Host", settings, collection: hostCollection });
      const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest", collection: guestCollection });
      arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "host-real-ready" });
      arena.setReady(host.room.id, guest.credential.token, { ready: true, commandId: "guest-real-ready" });
      arena.setLoaded(host.room.id, host.credential.token, { commandId: "host-real-loaded" });
      let view = arena.setLoaded(host.room.id, guest.credential.token, { commandId: "guest-real-loaded" });
      for (let pick = 0; pick < 16; pick += 1) {
        const credential = view.activeSeat === "a" ? host.credential : guest.credential;
        view = arena.getView(view.id, credential.token);
        const choice = firstLegal(view);
        view = arena.pick(view.id, credential.token, { ...choice, commandId: `real-${pick}`, expectedRevision: view.revision });
      }
      for (const credential of [host.credential, guest.credential]) {
        const completed = arena.getView(host.room.id, credential.token);
        const ownDeck = completed.participants.find((participant) => participant.seat === credential.seat)?.deck ?? [];
        const champions = ownDeck.filter((entry) => entry.form === "champion");
        expect(champions).toHaveLength(1);
        expect(championKeys).toContain(champions[0]?.cardKey);
        expect(completed.export?.entries[1]?.form).toBe("champion");
        expect(completed.export?.url).not.toContain("form");
      }
    }

    const disabled = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const disabledHost = disabled.createRoom({ name: "Host", settings: { ...settings, specialForms: false }, collection: hostCollection });
    const disabledGuest = disabled.joinRoom({ inviteCode: disabledHost.room.inviteCode, name: "Guest", collection: guestCollection });
    disabled.setReady(disabledHost.room.id, disabledHost.credential.token, { ready: true, commandId: "disabled-host-ready" });
    expect(() => disabled.setReady(disabledHost.room.id, disabledGuest.credential.token, {
      ready: true,
      commandId: "disabled-guest-ready",
    })).toThrowError(/complete|legal deck|filtered catalog|eligible cards/i);
  });

  it("places Evo, Hero, and wild choices into their actual export positions", () => {
    const arena = service();
    const included = catalog.slice(0, 36).map((card) => card.key);
    const host = arena.createRoom({
      name: "Host",
      settings: { mode: "mega", poolSize: 36, pickSeconds: 120, specialForms: true, battleMode: "Friendly", includeCards: included },
    });
    const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest" });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "host-ready" });
    arena.setReady(host.room.id, guest.credential.token, { ready: true, commandId: "guest-ready" });
    arena.setLoaded(host.room.id, host.credential.token, { commandId: "host-loaded" });
    let view = arena.setLoaded(host.room.id, guest.credential.token, { commandId: "guest-loaded" });
    const desired: Array<"evolution" | "hero"> = ["evolution", "evolution", "hero"];
    for (let pick = 0; pick < 16; pick += 1) {
      const credential = view.activeSeat === "a" ? host.credential : guest.credential;
      view = arena.getView(view.id, credential.token);
      let choice = firstLegal(view);
      if (credential.seat === "a" && desired.length) {
        const requested = desired[0] as "evolution" | "hero";
        const cell = view.board.find((candidate) => candidate.legalForms.includes(requested));
        if (cell) {
          choice = { cardKey: cell.cardKey, form: requested };
          desired.shift();
        }
      }
      view = arena.pick(view.id, credential.token, { ...choice, commandId: `slot-${pick}`, expectedRevision: view.revision });
    }
    const hostComplete = arena.getView(host.room.id, host.credential.token);
    expect(desired).toEqual([]);
    expect(hostComplete.export?.entries.slice(0, 3).map((entry) => entry.form)).toEqual(["evolution", "hero", "evolution"]);
    expect(hostComplete.export?.url).not.toMatch(/evolution|hero|champion|form/i);
  });

  it("blocks a second Champion choice and rejects a small pool that forces two into one deck", () => {
    const champions = realCatalogPayload.cards
      .filter((card) => card.forms.length === 1 && card.forms[0]?.key === "champion")
      .slice(0, 2)
      .map((card) => card.key);
    const bases = realCatalogPayload.cards.filter((card) => card.forms.some((form) => form.key === "base")).slice(0, 16).map((card) => card.key);
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const settings: ArenaSettings = {
      mode: "mega",
      poolSize: 18,
      pickSeconds: 120,
      specialForms: true,
      battleMode: "Friendly",
      includeCards: [...champions, ...bases],
    };
    const pair = createPairWithSettings(arena, settings);
    let hostView = arena.getView(pair.host.room.id, pair.host.credential.token);
    const firstChampion = hostView.board.find((cell) => cell.cardKey === champions[0]);
    expect(firstChampion?.legalForms).toEqual(["champion"]);
    arena.pick(hostView.id, pair.host.credential.token, {
      cardKey: champions[0] as string,
      form: "champion",
      commandId: "first-champion",
      expectedRevision: hostView.revision,
    });
    let guestPick = 0;
    while ((hostView = arena.getView(pair.host.room.id, pair.host.credential.token)).activeSeat !== "a") {
      const guestView = arena.getView(pair.host.room.id, pair.guest.credential.token);
      const base = guestView.board.find((cell) => !champions.includes(cell.cardKey) && cell.legalForms.includes("base"));
      expect(base).toBeDefined();
      arena.pick(guestView.id, pair.guest.credential.token, {
        cardKey: base!.cardKey,
        form: "base",
        commandId: `avoid-second-champion-${guestPick++}`,
        expectedRevision: guestView.revision,
      });
    }
    const secondChampion = hostView.board.find((cell) => cell.cardKey === champions[1]);
    expect(secondChampion?.legalForms).toEqual([]);
    expect(() => arena.pick(hostView.id, pair.host.credential.token, {
      cardKey: champions[1] as string,
      form: "champion",
      commandId: "blocked-second-champion",
      expectedRevision: hostView.revision,
    })).toThrowError(/legal completion/i);

    const rejected = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const rejectedIncluded = [...champions, ...bases.slice(0, 14)];
    const rejectedSettings = { ...settings, poolSize: 16, includeCards: rejectedIncluded };
    const rejectedHost = rejected.createRoom({
      name: "Host",
      settings: rejectedSettings,
      collection: { cards: [...champions, ...bases.slice(0, 6)], forms: null, source: "manual" },
    });
    const rejectedGuest = rejected.joinRoom({
      inviteCode: rejectedHost.room.inviteCode,
      name: "Guest",
      collection: { cards: bases.slice(6, 14), forms: null, source: "manual" },
    });
    rejected.setReady(rejectedHost.room.id, rejectedHost.credential.token, { ready: true, commandId: "three-host-ready" });
    expect(() => rejected.setReady(rejectedHost.room.id, rejectedGuest.credential.token, {
      ready: true,
      commandId: "three-guest-ready",
    })).toThrowError(/complete|legal deck|form-compatible/i);
  });

  it("allows two Heroes or one Hero plus one Champion while blocking a third combined form", () => {
    const champion = realCatalogPayload.cards.find((card) => card.forms.length === 1 && card.forms[0]?.key === "champion")?.key as string;
    const heroes = realCatalogPayload.cards.filter((card) => card.forms.some((form) => form.key === "hero") && card.forms.some((form) => form.key === "base")).slice(0, 3).map((card) => card.key);
    const bases = realCatalogPayload.cards.filter((card) => card.forms.some((form) => form.key === "base") && !heroes.includes(card.key)).slice(0, 20).map((card) => card.key);
    const settings: ArenaSettings = {
      mode: "mega",
      poolSize: 24,
      pickSeconds: 120,
      specialForms: true,
      battleMode: "Friendly",
      includeCards: [champion, ...heroes, ...bases],
    };
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const pair = createPairWithSettings(arena, settings);
    let guestPick = 0;
    const hostPick = (cardKey: string, form: "hero" | "champion", label: string) => {
      let hostView = arena.getView(pair.host.room.id, pair.host.credential.token);
      while (hostView.activeSeat !== "a") {
        const guestView = arena.getView(pair.host.room.id, pair.guest.credential.token);
        const base = guestView.board.find((cell) => cell.legalForms.includes("base") && cell.cardKey !== cardKey && !heroes.includes(cell.cardKey));
        expect(base).toBeDefined();
        arena.pick(guestView.id, pair.guest.credential.token, { cardKey: base!.cardKey, form: "base", commandId: `combined-guest-${guestPick++}`, expectedRevision: guestView.revision });
        hostView = arena.getView(pair.host.room.id, pair.host.credential.token);
      }
      expect(hostView.board.find((cell) => cell.cardKey === cardKey)?.legalForms).toContain(form);
      arena.pick(hostView.id, pair.host.credential.token, { cardKey, form, commandId: label, expectedRevision: hostView.revision });
    };
    hostPick(champion, "champion", "combined-champion");
    hostPick(heroes[0] as string, "hero", "combined-hero");
    let hostView = arena.getView(pair.host.room.id, pair.host.credential.token);
    while (hostView.activeSeat !== "a") {
      const guestView = arena.getView(pair.host.room.id, pair.guest.credential.token);
      const base = guestView.board.find((cell) => cell.legalForms.includes("base") && !heroes.includes(cell.cardKey));
      arena.pick(guestView.id, pair.guest.credential.token, { cardKey: base!.cardKey, form: "base", commandId: `combined-guest-${guestPick++}`, expectedRevision: guestView.revision });
      hostView = arena.getView(pair.host.room.id, pair.host.credential.token);
    }
    const third = hostView.board.find((cell) => cell.cardKey === heroes[1]);
    expect(third?.legalForms).toContain("base");
    expect(third?.legalForms).not.toContain("hero");

    const heroesOnlyArena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const heroesOnly = createPairWithSettings(heroesOnlyArena, settings);
    let heroesGuestPick = 0;
    for (const hero of heroes.slice(0, 2)) {
      let view = heroesOnlyArena.getView(heroesOnly.host.room.id, heroesOnly.host.credential.token);
      while (view.activeSeat !== "a") {
        const guestView = heroesOnlyArena.getView(heroesOnly.host.room.id, heroesOnly.guest.credential.token);
        const base = guestView.board.find((cell) => cell.legalForms.includes("base") && !heroes.includes(cell.cardKey));
        heroesOnlyArena.pick(guestView.id, heroesOnly.guest.credential.token, { cardKey: base!.cardKey, form: "base", commandId: `heroes-only-guest-${heroesGuestPick++}`, expectedRevision: guestView.revision });
        view = heroesOnlyArena.getView(heroesOnly.host.room.id, heroesOnly.host.credential.token);
      }
      expect(view.board.find((cell) => cell.cardKey === hero)?.legalForms).toContain("hero");
      heroesOnlyArena.pick(view.id, heroesOnly.host.credential.token, { cardKey: hero, form: "hero", commandId: `heroes-only-${hero}`, expectedRevision: view.revision });
    }
    const own = heroesOnlyArena.getView(heroesOnly.host.room.id, heroesOnly.host.credential.token).participants.find((participant) => participant.seat === "a")?.deck ?? [];
    expect(own.filter((entry) => entry.form === "hero")).toHaveLength(2);
  });

  it("keeps automatic completion within one Champion per deck", () => {
    let timestamp = 1_000;
    const champions = realCatalogPayload.cards.filter((card) => card.forms.length === 1 && card.forms[0]?.key === "champion").slice(0, 2).map((card) => card.key);
    const bases = realCatalogPayload.cards.filter((card) => card.forms.some((form) => form.key === "base")).slice(0, 14).map((card) => card.key);
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version, now: () => timestamp });
    const host = arena.createRoom({
      name: "Host",
      practice: true,
      settings: { mode: "mega", poolSize: 16, pickSeconds: 1, timerMode: "whole_draft", specialForms: true, battleMode: "Friendly", includeCards: [...champions, ...bases] },
    });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "champion-timeout-ready" });
    const started = arena.setLoaded(host.room.id, host.credential.token, { commandId: "champion-timeout-loaded" });
    timestamp = 2_001;
    expect(() => arena.pick(host.room.id, host.credential.token, {
      ...firstLegal(started),
      commandId: "champion-timeout-trigger",
      expectedRevision: started.revision,
    })).toThrowError(/automatic pick was committed/i);
    const completed = arena.getView(host.room.id, host.credential.token);
    expect(completed.phase).toBe("complete");
    for (const participant of completed.participants) {
      expect(participant.deck.filter((entry) => entry.form === "champion")).toHaveLength(1);
    }
  });

  it("assigns an intrinsic Champion to a Classic recipient without exceeding the recipient cap", () => {
    const champion = realCatalogPayload.cards.find((card) => card.forms.length === 1 && card.forms[0]?.key === "champion")?.key as string;
    const bases = realCatalogPayload.cards.filter((card) => card.forms.some((form) => form.key === "base")).slice(0, 15).map((card) => card.key);
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const pair = createPairWithSettings(arena, {
      mode: "classic",
      poolSize: 16,
      pickSeconds: 120,
      timerMode: "whole_draft",
      specialForms: true,
      battleMode: "Friendly",
      includeCards: [champion, ...bases],
    });
    let giftedTo: "a" | "b" | null = null;
    for (let step = 0; step < 8 && arena.getView(pair.host.room.id, pair.host.credential.token).phase !== "complete"; step += 1) {
      for (const credential of [pair.host.credential, pair.guest.credential]) {
        const view = arena.getView(pair.host.room.id, credential.token);
        if (view.phase === "drafting" && view.activeSeat === credential.seat) {
          const offeredChampion = view.board.some((cell) => cell.cardKey === champion);
          const other = offeredChampion ? view.board.find((cell) => cell.cardKey !== champion && cell.legalForms.includes("base")) : undefined;
          const choice = other ? { cardKey: other.cardKey, form: "base" as const } : firstLegal(view);
          const after = arena.pick(view.id, credential.token, { ...choice, commandId: `classic-cap-${credential.seat}-${step}`, expectedRevision: view.revision });
          const receivedChampion = after.events.at(-1)?.received;
          if (receivedChampion?.cardKey === champion) giftedTo = receivedChampion.seat;
        }
      }
    }
    expect(giftedTo).not.toBeNull();
    const recipient = giftedTo === "a" ? pair.host.credential : pair.guest.credential;
    const recipientComplete = arena.getView(pair.host.room.id, recipient.token);
    const recipientDeck = recipientComplete.participants.find((participant) => participant.seat === giftedTo)?.deck ?? [];
    expect(recipientComplete.phase).toBe("complete");
    expect(recipientDeck.filter((entry) => entry.form === "champion")).toHaveLength(1);
    expect(recipientComplete.exportError).toBeUndefined();
  });

  it("preserves a legacy completed two-Champion deck but refuses to emit an illegal export", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arena-legacy-champion-export-"));
    tempRoots.push(tempRoot);
    const databasePath = path.join(tempRoot, "arena.sqlite");
    let arena = service({ databasePath });
    const pair = createPair(arena);
    completePair(arena, pair, "legacy-export");
    arena.close();
    services.splice(services.indexOf(arena), 1);

    const inspection = new DatabaseSync(databasePath);
    const row = inspection.prepare("SELECT state_json FROM arena_rooms WHERE id = ?").get(pair.host.room.id) as { state_json: string };
    const state = JSON.parse(row.state_json) as { decks: { a: Array<{ cardKey: string; form: string }> } };
    const untouched = new Set(state.decks.a.slice(2).map((entry) => entry.cardKey));
    const championCards = catalog.filter((card) => card.forms.some((form) => form.key === "champion") && !untouched.has(card.key)).slice(0, 2);
    expect(championCards).toHaveLength(2);
    state.decks.a[0] = { ...state.decks.a[0]!, cardKey: championCards[0]!.key, form: "champion" };
    state.decks.a[1] = { ...state.decks.a[1]!, cardKey: championCards[1]!.key, form: "champion" };
    inspection.prepare("UPDATE arena_rooms SET state_json = ? WHERE id = ?").run(JSON.stringify(state), pair.host.room.id);
    inspection.close();

    arena = service({ databasePath });
    const resumed = arena.getView(pair.host.room.id, pair.host.credential.token);
    const preserved = resumed.participants.find((participant) => participant.seat === "a")?.deck ?? [];
    expect(preserved.filter((entry) => entry.form === "champion")).toHaveLength(2);
    expect(resumed.export).toBeUndefined();
    expect(resumed.exportError).toMatch(/at most one Champion/i);
  });

  it.each(["triple", "classic"] as const)("completes every %s decision with two eight-card decks", (mode) => {
    const arena = service();
    const pair = createPair(arena, mode);
    let view = pair.started;
    const decisionsPerSeat = mode === "classic" ? 4 : 8;
    for (let pick = 0; pick < decisionsPerSeat; pick += 1) {
      for (const seat of ["a", "b"] as const) {
        const credential = credentialFor(pair, seat);
        view = arena.getView(view.id, credential.token);
        const choice = firstLegal(view);
        view = arena.pick(view.id, credential.token, { ...choice, commandId: `${mode}-${seat}-${pick}`, expectedRevision: view.revision });
      }
    }
    expect(view.phase).toBe("complete");
    expect(view.participants.map((participant) => participant.deckCount)).toEqual([8, 8]);
    for (const credential of [pair.host.credential, pair.guest.credential]) {
      const privateView = arena.getView(view.id, credential.token);
      const own = privateView.participants.find((participant) => participant.seat === credential.seat);
      const opponent = privateView.participants.find((participant) => participant.seat !== credential.seat);
      expect(own?.deck).toHaveLength(8);
      expect(opponent?.deckCount).toBe(8);
      expect(opponent?.deck).toHaveLength(mode === "classic" ? 4 : 0);
      expect(opponent?.deck.every((entry) => entry.pickedBy === credential.seat)).toBe(true);
      expect(privateView.events).toHaveLength(decisionsPerSeat);
      expect(privateView.events.every((event) => event.seat === credential.seat)).toBe(true);
      expect(privateView.export?.entries).toHaveLength(8);
    }
  });

  it("keeps a room's catalog snapshot stable across a service restart", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arena-catalog-test-"));
    tempRoots.push(tempRoot);
    const databasePath = path.join(tempRoot, "arena.sqlite");
    let arena = service({ databasePath, catalogUpdatedAt: "2026-01-01T00:00:00.000Z" });
    const pair = createPair(arena);
    let view = pair.started;
    for (let pick = 0; pick < 16; pick += 1) {
      const credential = credentialFor(pair, view.activeSeat as "a" | "b");
      view = arena.getView(view.id, credential.token);
      view = arena.pick(view.id, credential.token, { ...firstLegal(view), commandId: `snapshot-${pick}`, expectedRevision: view.revision });
    }
    const originalExportKeys = arena.getView(pair.host.room.id, pair.host.credential.token).export?.entries.map((entry) => entry.cardKey) ?? [];
    arena.close();
    services.splice(services.indexOf(arena), 1);
    const replacementCatalog = catalog.map((card, index) => ({ ...card, key: `replacement-${index + 1}`, id: card.id + 10_000 }));
    arena = service({ databasePath, catalog: replacementCatalog, catalogVersion: "test-v2", catalogUpdatedAt: "2026-02-01T00:00:00.000Z" });
    const resumed = arena.getView(pair.host.room.id, pair.host.credential.token);
    const roomCatalog = arena.getRoomCatalog(pair.host.room.id, pair.host.credential.token);
    expect(resumed.catalogVersion).toBe("test-v1");
    expect(resumed.phase).toBe("complete");
    expect(resumed.export?.entries.map((entry) => entry.cardKey)).toEqual(originalExportKeys);
    expect(roomCatalog).toEqual({ version: "test-v1", updatedAt: "2026-01-01T00:00:00.000Z", cards: catalog });
    expect(arena.catalog.version).toBe("test-v2");
    expect(arena.catalog.cards).toEqual(replacementCatalog);
    expect(arena.catalog.cards.some((card) => originalExportKeys.includes(card.key))).toBe(false);
    expect(() => arena.getRoomCatalog(pair.host.room.id, "invalid-token")).toThrowError(/credentials/i);
  });

  it("resumes persisted rooms and commits elapsed bot turns", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arena-test-"));
    tempRoots.push(tempRoot);
    const databasePath = path.join(tempRoot, "arena.sqlite");
    let arena = service({ databasePath, botDelayMs: 10 });
    const created = arena.createRoom({ name: "Host", practice: true, settings: { mode: "mega", poolSize: 36, pickSeconds: 2, specialForms: true, battleMode: "Friendly" } });
    arena.setReady(created.room.id, created.credential.token, { ready: true, commandId: "ready" });
    let view = arena.setLoaded(created.room.id, created.credential.token, { commandId: "loaded" });
    const choice = firstLegal(view);
    view = arena.pick(view.id, created.credential.token, { ...choice, commandId: "host-pick", expectedRevision: view.revision });
    expect(view.activeSeat).toBe("b");
    arena.close();
    services.splice(services.indexOf(arena), 1);

    arena = service({ databasePath, botDelayMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resumed = arena.getView(created.room.id, created.credential.token);
    expect(resumed.events.length).toBeGreaterThanOrEqual(2);
    expect(resumed.events[1]).toMatchObject({ seat: "b", automatic: true });
  });

  it("uses grouped form locks for automatic whole-draft completion", () => {
    let timestamp = 1_000;
    const arena = service({ catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version, now: () => timestamp });
    const host = arena.createRoom({
      name: "Host",
      practice: true,
      settings: { mode: "triple", groupedSpecialRounds: true, poolSize: 36, pickSeconds: 1, timerMode: "whole_draft", specialForms: true, battleMode: "Friendly" },
    });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "grouped-auto-ready" });
    const started = arena.setLoaded(host.room.id, host.credential.token, { commandId: "grouped-auto-loaded" });
    timestamp = 2_000;
    expect(() => arena.pick(host.room.id, host.credential.token, {
      ...firstLegal(started),
      commandId: "grouped-auto-expired",
      expectedRevision: started.revision,
    })).toThrowError(/automatic pick was committed/i);
    const completed = arena.getView(host.room.id, host.credential.token);
    const own = completed.participants.find((participant) => participant.seat === "a");
    const bot = completed.participants.find((participant) => participant.seat === "b");
    expect(completed.phase).toBe("complete");
    expect(own?.deck.map((entry) => entry.form)).toEqual([
      "evolution", "evolution", expect.stringMatching(/hero|champion/), "base", "base", "base", "base", "base",
    ]);
    expect(completed.events).toHaveLength(8);
    expect(completed.events.every((event) => event.automatic)).toBe(true);
    expect(bot).toMatchObject({ deck: [], deckCount: 8, bot: true });
  });

  it("restores viewer-specific grouped round metadata and locked offers", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arena-grouped-restart-"));
    tempRoots.push(tempRoot);
    const databasePath = path.join(tempRoot, "arena.sqlite");
    let arena = service({ databasePath, catalog: realCatalogPayload.cards, catalogVersion: realCatalogPayload.version });
    const host = arena.createRoom({ name: "Host", settings: { mode: "triple", groupedSpecialRounds: true } });
    const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest" });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "grouped-restart-host-ready" });
    arena.setReady(host.room.id, guest.credential.token, { ready: true, commandId: "grouped-restart-guest-ready" });
    arena.setLoaded(host.room.id, host.credential.token, { commandId: "grouped-restart-host-loaded" });
    arena.setLoaded(host.room.id, guest.credential.token, { commandId: "grouped-restart-guest-loaded" });
    const hostView = arena.getView(host.room.id, host.credential.token);
    arena.pick(host.room.id, host.credential.token, { ...firstLegal(hostView), commandId: "grouped-before-restart", expectedRevision: hostView.revision });
    arena.close();
    services.splice(services.indexOf(arena), 1);
    arena = service({ databasePath, catalog: catalog.slice().reverse(), catalogVersion: "replacement" });
    const resumedHost = arena.getView(host.room.id, host.credential.token);
    const resumedGuest = arena.getView(host.room.id, guest.credential.token);
    expect(resumedHost.currentRound).toMatchObject({ roundNumber: 2, kind: "evolution", remainingSpecialRounds: 2 });
    expect(resumedGuest.currentRound).toMatchObject({ roundNumber: 1, kind: "evolution", remainingSpecialRounds: 3 });
    expect(resumedHost.board.filter((cell) => cell.offeredTo === "a").every((cell) => cell.legalForms[0] === "evolution")).toBe(true);
    expect(resumedGuest.board.filter((cell) => cell.offeredTo === "b").every((cell) => cell.legalForms[0] === "evolution")).toBe(true);
  });

  it("commits an elapsed human deadline from persisted server time", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arena-deadline-test-"));
    tempRoots.push(tempRoot);
    const databasePath = path.join(tempRoot, "arena.sqlite");
    let timestamp = 1_000;
    let arena = service({ databasePath, now: () => timestamp });
    const host = arena.createRoom({ name: "Host", settings: { mode: "mega", poolSize: 36, pickSeconds: 1, specialForms: true, battleMode: "Friendly" } });
    const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest" });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "host-ready" });
    arena.setReady(host.room.id, guest.credential.token, { ready: true, commandId: "guest-ready" });
    arena.setLoaded(host.room.id, host.credential.token, { commandId: "host-loaded" });
    arena.setLoaded(host.room.id, guest.credential.token, { commandId: "guest-loaded" });
    arena.close();
    services.splice(services.indexOf(arena), 1);
    timestamp = 3_000;
    arena = service({ databasePath, now: () => timestamp });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const resumed = arena.getView(host.room.id, host.credential.token);
    expect(resumed.events[0]).toMatchObject({ seat: "a", automatic: true, at: 3_000 });
  });

  it("resumes and completes an elapsed persisted whole-draft deadline", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arena-whole-deadline-test-"));
    tempRoots.push(tempRoot);
    const databasePath = path.join(tempRoot, "arena.sqlite");
    let timestamp = 1_000;
    let arena = service({ databasePath, now: () => timestamp });
    const host = arena.createRoom({
      name: "Host",
      settings: { mode: "triple", poolSize: 36, pickSeconds: 1, timerMode: "whole_draft", specialForms: true, battleMode: "Friendly" },
    });
    const guest = arena.joinRoom({ inviteCode: host.room.inviteCode, name: "Guest" });
    arena.setReady(host.room.id, host.credential.token, { ready: true, commandId: "restart-whole-host-ready" });
    arena.setReady(host.room.id, guest.credential.token, { ready: true, commandId: "restart-whole-guest-ready" });
    arena.setLoaded(host.room.id, host.credential.token, { commandId: "restart-whole-host-loaded" });
    arena.setLoaded(host.room.id, guest.credential.token, { commandId: "restart-whole-guest-loaded" });
    arena.close();
    services.splice(services.indexOf(arena), 1);
    timestamp = 2_000;
    arena = service({ databasePath, now: () => timestamp });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const resumed = arena.getView(host.room.id, host.credential.token);
    expect(resumed.phase).toBe("complete");
    expect(resumed.events).toHaveLength(8);
    expect(new Set(resumed.events.map((event) => event.at))).toEqual(new Set([2_000]));
  });
});

describe("arena HTTP boundary", () => {
  it("serves the contract and rejects missing bearer credentials and oversized parsed bodies", async () => {
    const app = createArenaApp({ catalog, catalogVersion: "test-v1", databasePath: ":memory:", presentationDelayMs: 0 });
    services.push(app.locals.arenaService as ArenaService);
    const catalogResponse = await request(app).get("/api/arena/catalog").expect(200);
    expect(catalogResponse.body.cards).toHaveLength(catalog.length);
    const created = await request(app).post("/api/arena/rooms").send({ name: "Host", practice: true }).expect(201);
    await request(app).get(`/api/arena/rooms/${created.body.room.id}`).expect(401);
    const roomCatalog = await request(app)
      .get(`/api/arena/rooms/${created.body.room.id}/catalog`)
      .set("Authorization", `Bearer ${created.body.credential.token}`)
      .expect(200);
    expect(roomCatalog.body).toMatchObject({ version: "test-v1", cards: catalog });
    await request(app).get(`/api/arena/rooms/${created.body.room.id}/catalog`).expect(401);
    const tooLarge = await request(app)
      .post(`/api/arena/rooms/${created.body.room.id}/ready`)
      .set("Authorization", `Bearer ${created.body.credential.token}`)
      .send({ ready: true, commandId: "x".repeat(70_000) })
      .expect(413);
    expect(tooLarge.body).toEqual({ error: "Request body is too large", code: "BODY_TOO_LARGE" });
  });

  it("cannot bypass the IP rate bound by varying Authorization headers", async () => {
    const app = createArenaApp({ catalog, catalogVersion: "test-v1", databasePath: ":memory:" });
    services.push(app.locals.arenaService as ArenaService);
    for (let index = 0; index < 60; index += 1) {
      await request(app).get("/api/arena/catalog").set("Authorization", `Bearer varied-${index}`).expect(200);
    }
    await request(app).get("/api/arena/catalog").set("Authorization", "Bearer another-value").expect(429);
  });

  it("authenticates SSE with the bearer header and rejects URL credentials", async () => {
    const app = createArenaApp({ catalog, catalogVersion: "test-v1", databasePath: ":memory:", initialDealMs: 0 });
    services.push(app.locals.arenaService as ArenaService);
    const created = await request(app).post("/api/arena/rooms").send({ name: "Host", practice: true }).expect(201);
    await request(app).get(`/api/arena/rooms/${created.body.room.id}/events?token=${created.body.credential.token}`).expect(401);
    const server = app.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/arena/rooms/${created.body.room.id}/events`, {
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${created.body.credential.token}`,
        },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body?.getReader();
      const firstChunk = await reader?.read();
      expect(new TextDecoder().decode(firstChunk?.value)).toContain("event: room");
      await reader?.cancel();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
