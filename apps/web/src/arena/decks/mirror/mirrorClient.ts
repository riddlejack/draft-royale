import type { MirrorPlaylistKey, MirrorRoomCommand, MirrorRoomCredential, MirrorRoomSessionResponse, MirrorRoomView } from "@draft-royale/shared";

export class MirrorRoomApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

async function request<T>(path: string, options: { body?: unknown; credential?: MirrorRoomCredential; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(`/api/mirror${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.credential ? { Authorization: `Bearer ${options.credential.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal ?? AbortSignal.timeout(15_000),
  });
  let data: unknown;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const error = data && typeof data === "object" ? data as { error?: unknown; code?: unknown } : {};
    throw new MirrorRoomApiError(typeof error.error === "string" ? error.error : `Mirror room unavailable (${response.status}).`, response.status, typeof error.code === "string" ? error.code : undefined);
  }
  return data as T;
}

export const createMirrorRoom = (name: string, playlist: MirrorPlaylistKey = "mirror") => request<MirrorRoomSessionResponse>("/rooms", { body: { name, playlist } });
export const joinMirrorRoom = (name: string, code: string) => request<MirrorRoomSessionResponse>("/join", { body: { name, code: code.trim().toUpperCase() } });
export const getMirrorRoom = (credential: MirrorRoomCredential, signal?: AbortSignal) => request<{ room: MirrorRoomView }>(`/rooms/${encodeURIComponent(credential.roomId)}`, { credential, signal });
export const commandMirrorRoom = (credential: MirrorRoomCredential, command: MirrorRoomCommand) => request<{ room: MirrorRoomView }>(`/rooms/${encodeURIComponent(credential.roomId)}/command`, { credential, body: command });
export const mirrorCommandId = () => typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const mirrorCredentialKey = "draft-royale:mirror-room";
export function readMirrorCredential(): MirrorRoomCredential | null {
  try {
    const value = JSON.parse(localStorage.getItem(mirrorCredentialKey) ?? "null") as Partial<MirrorRoomCredential> | null;
    return value && typeof value.roomId === "string" && (value.seat === "a" || value.seat === "b") && typeof value.token === "string" ? value as MirrorRoomCredential : null;
  } catch { return null; }
}
export function writeMirrorCredential(value: MirrorRoomCredential | null) {
  try { if (value) localStorage.setItem(mirrorCredentialKey, JSON.stringify(value)); else localStorage.removeItem(mirrorCredentialKey); } catch { /* Current room remains usable in memory. */ }
}
