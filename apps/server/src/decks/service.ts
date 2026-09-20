import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ArenaCard, ArenaForm, DeckDefinition } from "@draft-royale/shared";
import { isChaosInfiniteElixirSupportedCard } from "@draft-royale/shared";

export class DeckError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export type StoredDeck = DeckDefinition & { ownerId: string; author: string; visibility: "private" | "public" };
type DeckRow = { id: string; owner_id: string; visibility: string; json: string };
const record = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DeckError(400, "A deck object is required.");
  return input as Record<string, unknown>;
};
const text = (value: unknown, label: string, max: number, fallback?: string) => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new DeckError(400, `${label} must contain 1–${max} characters.`);
  return value.trim();
};

/** Shared by the published library and synchronized deck rooms. Never trust a browser's legality check. */
export function validateLibraryDeck(input: unknown, catalog: readonly ArenaCard[]): DeckDefinition {
  const value = record(input);
  const cardsByKey = new Map(catalog.map((card) => [card.key, card]));
  if (!Array.isArray(value.cards) || value.cards.length !== 8 || new Set(value.cards).size !== 8 || value.cards.some((key) => typeof key !== "string" || !cardsByKey.has(key))) throw new DeckError(400, "Choose eight different cards from the catalog.");
  const cards = value.cards as string[];
  if (!["2v2", "classic", "chaos", "mirror", "custom"].includes(String(value.mode))) throw new DeckError(400, "Choose a valid deck category.");
  const mode = value.mode as DeckDefinition["mode"];
  if (mode === "mirror" && !cards.includes("mirror")) throw new DeckError(400, "Mirror decks must contain the Mirror card.");
  const rawForms = value.forms === undefined ? {} : record(value.forms);
  if (Object.keys(rawForms).some((key) => !cards.includes(key))) throw new DeckError(400, "Forms must belong to cards in this deck.");
  const forms: Record<string, ArenaForm> = {};
  for (const key of cards) {
    const card = cardsByKey.get(key)!;
    const form = rawForms[key] ?? (card.forms.some((candidate) => candidate.key === "base") ? "base" : "champion");
    if (!card.forms.some((candidate) => candidate.key === form)) throw new DeckError(400, `${card.name} does not have that form.`);
    forms[key] = form as ArenaForm;
    if (mode === "chaos" && (!isChaosInfiniteElixirSupportedCard(card) || form !== "base")) throw new DeckError(400, `${card.name} is unavailable in the current Chaos Infinite Elixir pool.`);
  }
  const chosen = Object.values(forms);
  const evos = chosen.filter((form) => form === "evolution").length;
  const heroes = chosen.filter((form) => form === "hero" || form === "champion").length;
  if (evos > 2 || heroes > 2 || evos + heroes > 3 || chosen.filter((form) => form === "champion").length > 1) throw new DeckError(400, "Use at most two Evolutions, two Hero/Champion forms, one Champion, and three special forms total.");
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > 10)) throw new DeckError(400, "Use at most ten deck tags.");
  return {
    id: typeof value.id === "string" ? value.id.slice(0, 100) : "",
    name: text(value.name, "Deck name", 80), mode, cards, forms,
    ...(value.description ? { description: text(value.description, "Description", 1000) } : {}),
    tags: ((value.tags ?? []) as unknown[]).map((tag) => text(tag, "Tag", 40)),
    source: { kind: "community", label: "Community deck" },
  };
}

export function createDeckService(options: { databasePath: string; catalog: readonly ArenaCard[]; now?: () => number }) {
  const db = new DatabaseSync(options.databasePath);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  db.exec(`CREATE TABLE IF NOT EXISTS library_decks (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, visibility TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS library_decks_owner ON library_decks(owner_id);
    CREATE TABLE IF NOT EXISTS library_commands (owner_id TEXT NOT NULL, command_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(owner_id, command_id));`);
  const now = options.now ?? Date.now;
  const list = (ownerId?: string): StoredDeck[] => (ownerId
    ? db.prepare("SELECT json FROM library_decks WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 300").all(ownerId)
    : db.prepare("SELECT json FROM library_decks WHERE visibility = 'public' ORDER BY updated_at DESC LIMIT 500").all()
  ).map((row) => JSON.parse(row.json as string) as StoredDeck);
  /** Published decks are shared with friends, never site-wide. */
  const listPublishedBy = (ownerIds: readonly string[]): StoredDeck[] => {
    const owners = [...new Set(ownerIds)].slice(0, 500);
    if (owners.length === 0) return [];
    return db.prepare(`SELECT json FROM library_decks WHERE visibility = 'public' AND owner_id IN (${owners.map(() => "?").join(",")}) ORDER BY updated_at DESC LIMIT 500`).all(...owners)
      .map((row) => JSON.parse(row.json as string) as StoredDeck);
  };
  const save = (ownerId: string, author: string, input: unknown): StoredDeck => {
    const body = record(input);
    const commandId = text(body.commandId, "Operation ID", 100);
    const visibility = body.visibility ?? "private";
    if (visibility !== "private" && visibility !== "public") throw new DeckError(400, "Choose private or public visibility.");
    const valid = validateLibraryDeck(body.deck, options.catalog);
    const hash = createHash("sha256").update(JSON.stringify({ valid, visibility })).digest("hex");
    db.exec("BEGIN IMMEDIATE");
    try {
      const previous = db.prepare("SELECT payload_hash, result_json FROM library_commands WHERE owner_id=? AND command_id=?").get(ownerId, commandId);
      if (previous) {
        if (previous.payload_hash !== hash) throw new DeckError(409, "This operation ID was already used for another deck.");
        db.exec("COMMIT");
        return JSON.parse(previous.result_json as string) as StoredDeck;
      }
      const existing = valid.id.startsWith("deck_") ? db.prepare("SELECT * FROM library_decks WHERE id=?").get(valid.id) as unknown as DeckRow | undefined : undefined;
      if (existing && existing.owner_id !== ownerId) throw new DeckError(403, "Only the deck's author can change it. Save your own copy instead.");
      if (!existing && Number(db.prepare("SELECT COUNT(*) AS n FROM library_decks WHERE owner_id=?").get(ownerId)?.n) >= 300) throw new DeckError(409, "Your library is full. Remove a deck before adding another.");
      const deck: StoredDeck = { ...valid, id: existing?.id ?? `deck_${randomUUID()}`, ownerId, author: author.slice(0, 80), visibility, updatedAt: new Date(now()).toISOString(), source: { kind: "community", label: author.slice(0, 80) } };
      const json = JSON.stringify(deck);
      db.prepare("INSERT INTO library_decks VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET visibility=excluded.visibility,json=excluded.json,updated_at=excluded.updated_at").run(deck.id, ownerId, visibility, json, now());
      db.prepare("INSERT INTO library_commands VALUES(?,?,?,?)").run(ownerId, commandId, hash, json);
      db.exec("COMMIT");
      return deck;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const remove = (ownerId: string, id: string) => {
    const row = db.prepare("SELECT owner_id FROM library_decks WHERE id=?").get(id);
    if (!row) return;
    if (row.owner_id !== ownerId) throw new DeckError(403, "Only the author can remove this deck.");
    db.prepare("DELETE FROM library_decks WHERE id=? AND owner_id=?").run(id, ownerId);
  };
  return { list, listPublishedBy, save, remove, close: () => db.close() };
}
export type DeckService = ReturnType<typeof createDeckService>;
