import type { ArenaCatalogResponse, ArenaCredential, ArenaSessionResponse, ArenaView } from "@draft-royale/shared";
import { recordArenaClock } from "./clock";

export class ArenaApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export async function arenaRequest<T>(path: string, options: { body?: unknown; credential?: ArenaCredential; signal?: AbortSignal } = {}): Promise<T> {
  const sent = performance.now();
  const response = await fetch(`/api/arena${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.credential ? { Authorization: `Bearer ${options.credential.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal ?? AbortSignal.timeout(15_000),
  });
  let parsed: unknown;
  try { parsed = await response.json(); }
  catch (error) {
    if (response.ok) throw new TypeError("Arena returned an unreadable response.", { cause: error });
    parsed = {};
  }
  if (!response.ok) {
    const errorBody = isObject(parsed) ? parsed : {};
    throw new ArenaApiError(
      typeof errorBody.error === "string" ? errorBody.error : `Unable to connect (${response.status}). Please try again.`,
      response.status,
      typeof errorBody.code === "string" ? errorBody.code : undefined,
    );
  }
  if (!isObject(parsed)) throw new TypeError("Arena returned an invalid response.");
  const body = parsed as { serverNow?: unknown; room?: unknown };
  const nestedServerNow = isObject(body.room) ? body.room.serverNow : undefined;
  const serverNow = typeof body.serverNow === "number" ? body.serverNow : typeof nestedServerNow === "number" ? nestedServerNow : undefined;
  if (serverNow !== undefined) recordArenaClock(serverNow, sent, performance.now());
  return parsed as T;
}
export const getArenaCatalog = () => arenaRequest<ArenaCatalogResponse>("/catalog");
export const loadArenaRoom = (credential: ArenaCredential) => arenaRequest<ArenaView>(`/rooms/${encodeURIComponent(credential.roomId)}`, { credential });
export const loadRoomCatalog = (credential: ArenaCredential) => arenaRequest<ArenaCatalogResponse>(`/rooms/${encodeURIComponent(credential.roomId)}/catalog`, { credential });
export const commandId = () => typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const createArenaRoom = (body: unknown) => arenaRequest<ArenaSessionResponse>("/rooms", { body });
export const joinArenaRoom = (body: unknown) => arenaRequest<ArenaSessionResponse>("/join", { body });

const isArenaView = (value: unknown, credential: ArenaCredential): value is ArenaView => {
  if (!isObject(value)) return false;
  return value.id === credential.roomId
    && value.viewer === credential.seat
    && Number.isInteger(value.revision)
    && ["waiting", "loading", "drafting", "complete"].includes(String(value.phase))
    && Number.isFinite(value.serverNow)
    && isObject(value.settings)
    && Array.isArray(value.participants)
    && Array.isArray(value.board)
    && Array.isArray(value.events);
};

export async function sendArenaCommand(credential: ArenaCredential, command: string, body: Record<string, unknown>) {
  const request = { credential, body: { ...body, commandId: commandId() } };
  for (let attempt = 0; ; attempt += 1) {
    try {
      const view = await arenaRequest<unknown>(`/rooms/${encodeURIComponent(credential.roomId)}/${command}`, request);
      if (!isArenaView(view, credential)) throw new TypeError("Arena returned an invalid room response.");
      return view;
    }
    catch (error) {
      const transient = !(error instanceof ArenaApiError) || [408, 500, 502, 503, 504].includes(error.status);
      if (!transient || attempt >= 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

export const storage = {
  get<T>(key: string, fallback: T): T {
    try { const value = localStorage.getItem(`draft-royale:${key}`); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
  },
  set(key: string, value: unknown) { try { localStorage.setItem(`draft-royale:${key}`, JSON.stringify(value)); } catch { /* App remains playable when browser storage is restricted. */ } },
};
export function saveCredential(credential: ArenaCredential) {
  const saved = storage.get<ArenaCredential[]>("rooms", []).filter((item) => item.roomId !== credential.roomId);
  storage.set("rooms", [credential, ...saved].slice(0, 12));
}

export function forgetCredential(roomId: string) {
  storage.set("rooms", storage.get<ArenaCredential[]>("rooms", []).filter((item) => item.roomId !== roomId));
}
