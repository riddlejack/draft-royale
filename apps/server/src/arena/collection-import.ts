import type { ArenaCard, ArenaCollection, ArenaCollectionImportResponse, ArenaForm } from "@draft-royale/shared";

const DEFAULT_API_BASE_URL = "https://proxy.royaleapi.dev/v1";
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_STALE_MAX_MS = 24 * 60 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const MAX_API_BODY_BYTES = 5 * 1024 * 1024;

type UnknownRecord = Record<string, unknown>;

export class CollectionImportError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) { super(message); }
}

export interface CollectionImportServiceOptions {
  catalog: readonly ArenaCard[];
  apiToken?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
  staleMaxMs?: number;
  requestTimeoutMs?: number;
}

export interface CollectionImportService {
  importPlayer(tag: unknown): Promise<ArenaCollectionImportResponse>;
}

const isRecord = (value: unknown): value is UnknownRecord => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) ? value : null;

export const normalizePlayerTag = (value: unknown): string => {
  if (typeof value !== "string") throw new CollectionImportError(400, "Enter a Clash Royale player tag.", "INVALID_PLAYER_TAG");
  const tag = `#${value.trim().replace(/^#/, "").replace(/\s+/g, "").toUpperCase().replace(/O/g, "0")}`;
  if (!/^#[0289PYLQGRJCUV]{3,15}$/.test(tag)) {
    throw new CollectionImportError(400, "Enter a valid Clash Royale player tag, such as #2ABC123.", "INVALID_PLAYER_TAG");
  }
  return tag;
};

const parseUpstreamError = async (response: Response) => {
  let detail = "";
  try {
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_API_BODY_BYTES) return detail;
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_API_BODY_BYTES) return detail;
    const parsed = JSON.parse(body) as unknown;
    if (isRecord(parsed)) detail = text(parsed.message) || text(parsed.reason);
  } catch { /* Use the stable public error below. */ }
  return detail;
};

const mapProfile = (
  profile: unknown,
  requestedTag: string,
  catalog: readonly ArenaCard[],
  fetchedAt: number,
): { collection: ArenaCollection; warnings: string[] } => {
  if (!isRecord(profile)) throw new CollectionImportError(502, "Clash Royale returned an unreadable player profile.", "INVALID_API_RESPONSE");
  const returnedTag = normalizePlayerTag(profile.tag);
  if (returnedTag !== requestedTag) throw new CollectionImportError(502, "Clash Royale returned a different player profile.", "INVALID_API_RESPONSE");
  const playerName = text(profile.name);
  if (!playerName || playerName.length > 80 || !Array.isArray(profile.cards)) {
    throw new CollectionImportError(502, "Clash Royale returned an incomplete player profile.", "INVALID_API_RESPONSE");
  }

  const byId = new Map(catalog.map((card) => [card.id, card]));
  const cards = new Set<string>();
  const forms: Record<string, ArenaForm[]> = {};
  const warnings = new Set<string>();
  let unknownCards = 0;
  let invalidFormFlags = 0;
  let unsupportedFormFlags = 0;

  for (const rawCard of profile.cards) {
    if (!isRecord(rawCard)) continue;
    const id = integer(rawCard.id);
    const card = id === null ? undefined : byId.get(id);
    if (!card) { unknownCards += 1; continue; }
    cards.add(card.key);
    const owned = new Set<ArenaForm>();
    if (card.forms.some((form) => form.key === "champion")) owned.add("champion");

    const rawFlag = rawCard.evolutionLevel;
    const flag = rawFlag === undefined ? 0 : integer(rawFlag);
    if (flag === null || flag < 0 || flag > 3) {
      invalidFormFlags += 1;
    } else {
      const requestedForms: ArenaForm[] = [
        ...((flag & 1) === 1 ? ["evolution" as const] : []),
        ...((flag & 2) === 2 ? ["hero" as const] : []),
      ];
      for (const form of requestedForms) {
        if (card.forms.some((candidate) => candidate.key === form)) owned.add(form);
        else unsupportedFormFlags += 1;
      }
    }
    if (owned.size > 0) forms[card.key] = [...owned];
  }

  if (unknownCards > 0) warnings.add(`${unknownCards} profile card${unknownCards === 1 ? " was" : "s were"} not present in this catalog and stayed unavailable.`);
  if (invalidFormFlags > 0) warnings.add(`${invalidFormFlags} card${invalidFormFlags === 1 ? " had" : "s had"} an unknown form value; no special form was granted.`);
  if (unsupportedFormFlags > 0) warnings.add(`${unsupportedFormFlags} reported special form${unsupportedFormFlags === 1 ? " was" : "s were"} not supported by this catalog and stayed unavailable.`);
  const fetchedAtIso = new Date(fetchedAt).toISOString();
  return {
    collection: {
      cards: [...cards],
      forms,
      source: "api",
      profile: { tag: returnedTag, name: playerName, fetchedAt: fetchedAtIso },
    },
    warnings: [...warnings],
  };
};

export const createCollectionImportService = (options: CollectionImportServiceOptions): CollectionImportService => {
  const apiToken = options.apiToken?.trim() ?? "";
  const apiBaseUrl = (options.apiBaseUrl?.trim() || DEFAULT_API_BASE_URL).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const cacheTtlMs = Math.max(1_000, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
  const staleMaxMs = Math.max(cacheTtlMs, options.staleMaxMs ?? DEFAULT_STALE_MAX_MS);
  const requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const cache = new Map<string, { fetchedAt: number; collection: ArenaCollection; warnings: string[] }>();
  const inflight = new Map<string, Promise<ArenaCollectionImportResponse>>();

  const responseFor = (entry: { fetchedAt: number; collection: ArenaCollection; warnings: string[] }, cached: boolean, stale = false): ArenaCollectionImportResponse => ({
    collection: structuredClone(entry.collection),
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
    expiresAt: new Date(entry.fetchedAt + cacheTtlMs).toISOString(),
    cached,
    stale,
    warnings: [...entry.warnings, ...(stale ? ["Clash Royale could not be reached; showing the last successful import."] : [])],
  });

  const fetchPlayer = async (tag: string): Promise<ArenaCollectionImportResponse> => {
    if (!apiToken) throw new CollectionImportError(503, "Automatic collection import is not configured on this server.", "API_NOT_CONFIGURED");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(`${apiBaseUrl}/players/${encodeURIComponent(tag)}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${apiToken}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await parseUpstreamError(response);
        if (response.status === 404) throw new CollectionImportError(404, "No Clash Royale player was found for that tag.", "PLAYER_NOT_FOUND");
        if (response.status === 429) throw new CollectionImportError(503, "Clash Royale is rate limiting imports. Try again shortly.", "UPSTREAM_RATE_LIMITED");
        if (response.status === 401 || response.status === 403) throw new CollectionImportError(503, "The server's Clash Royale API key is not authorized.", "API_AUTH_FAILED");
        throw new CollectionImportError(502, detail ? `Clash Royale import failed: ${detail}` : "Clash Royale could not load that player profile.", "UPSTREAM_ERROR");
      }
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_API_BODY_BYTES) {
        throw new CollectionImportError(502, "Clash Royale returned a player profile that was too large.", "INVALID_API_RESPONSE");
      }
      const body = await response.text();
      if (Buffer.byteLength(body) > MAX_API_BODY_BYTES) throw new CollectionImportError(502, "Clash Royale returned a player profile that was too large.", "INVALID_API_RESPONSE");
      let parsed: unknown;
      try { parsed = JSON.parse(body); }
      catch { throw new CollectionImportError(502, "Clash Royale returned an unreadable player profile.", "INVALID_API_RESPONSE"); }
      const fetchedAt = now();
      const mapped = mapProfile(parsed, tag, options.catalog, fetchedAt);
      const entry = { fetchedAt, ...mapped };
      cache.set(tag, entry);
      return responseFor(entry, false);
    } catch (error) {
      if (error instanceof CollectionImportError) throw error;
      const previous = cache.get(tag);
      if (previous && now() - previous.fetchedAt <= staleMaxMs) return responseFor(previous, true, true);
      throw new CollectionImportError(502, error instanceof Error && error.name === "AbortError"
        ? "Clash Royale took too long to respond. Your saved collection was not changed."
        : "Clash Royale could not be reached. Your saved collection was not changed.", "UPSTREAM_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    importPlayer(rawTag) {
      const tag = normalizePlayerTag(rawTag);
      const current = cache.get(tag);
      if (current && now() - current.fetchedAt <= cacheTtlMs) return Promise.resolve(responseFor(current, true));
      const pending = inflight.get(tag);
      if (pending) return pending;
      const next = fetchPlayer(tag).finally(() => inflight.delete(tag));
      inflight.set(tag, next);
      return next;
    },
  };
};

