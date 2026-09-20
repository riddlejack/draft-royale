import { afterEach, describe, expect, it, vi } from "vitest";
import type { MirrorRoomCredential } from "@draft-royale/shared";
import { commandMirrorRoom, createMirrorRoom, joinMirrorRoom, readMirrorCredential, writeMirrorCredential } from "./mirrorClient";

const credential: MirrorRoomCredential = { roomId: "mirror-room", seat: "a", token: "secret-token" };
const response = { credential, room: { id: "mirror-room" } };

describe("Mirror room client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the create and normalized join endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => response });
    vi.stubGlobal("fetch", fetchMock);
    await createMirrorRoom("Host");
    await joinMirrorRoom("Guest", " abcd12 ");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/mirror/rooms");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body)).toEqual({ name: "Host", playlist: "classics" });
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body)).toEqual({ name: "Guest", code: "ABCD12" });
  });

  it("authenticates a revision-bound command", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ room: response.room }) });
    vi.stubGlobal("fetch", fetchMock);
    await commandMirrorRoom(credential, { action: "next", expectedRevision: 7, commandId: "next-7" });
    expect(fetchMock).toHaveBeenCalledWith("/api/mirror/rooms/mirror-room/command", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer secret-token" }),
      body: JSON.stringify({ action: "next", expectedRevision: 7, commandId: "next-7" }),
    }));
  });

  it("round-trips only a well-shaped saved credential", () => {
    let value: string | null = null;
    vi.stubGlobal("localStorage", { getItem: () => value, setItem: (_key: string, next: string) => { value = next; }, removeItem: () => { value = null; } });
    writeMirrorCredential(credential);
    expect(readMirrorCredential()).toEqual(credential);
    value = JSON.stringify({ roomId: "mirror-room", seat: "x", token: "secret-token" });
    expect(readMirrorCredential()).toBeNull();
  });
});
