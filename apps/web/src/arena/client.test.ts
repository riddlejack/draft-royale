import type { ArenaCredential, ArenaView } from "@draft-royale/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendArenaCommand } from "./client";
import type { ArenaApiError } from "./client";

const credential: ArenaCredential = { roomId: "room-1", seat: "a", token: "secret" };
const view: ArenaView = {
  id: credential.roomId,
  inviteCode: "ABC123",
  revision: 2,
  catalogVersion: "test-v1",
  phase: "waiting",
  viewer: credential.seat,
  settings: {
    mode: "mega",
    poolSize: 36,
    pickSeconds: 15,
    timerMode: "per_pick",
    specialForms: true,
    battleMode: "Friendly 1v1",
  },
  participants: [],
  board: [],
  activeSeat: null,
  pickNumber: 0,
  totalPicks: 16,
  startedAt: null,
  interactiveAt: null,
  deadlineAt: null,
  serverNow: 1_000,
  events: [],
};

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

const commandIds = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map((call) => {
  const options = call[1] as RequestInit;
  return (JSON.parse(String(options.body)) as { commandId: string }).commandId;
});

afterEach(() => vi.unstubAllGlobals());

describe("sendArenaCommand", () => {
  it("retries an unreadable successful response once with the same commandId", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse(view));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendArenaCommand(credential, "ready", { ready: true })).resolves.toEqual(view);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Set(commandIds(fetchMock))).toHaveLength(1);
  });

  it("retries a successful response without a valid room envelope", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse(view));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendArenaCommand(credential, "ready", { ready: true })).resolves.toEqual(view);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Set(commandIds(fetchMock))).toHaveLength(1);
  });

  it("retries an HTTP 500 once with the same commandId", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "Arena request failed", code: "INTERNAL_ERROR" }, 500))
      .mockResolvedValueOnce(jsonResponse(view));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendArenaCommand(credential, "ready", { ready: true })).resolves.toEqual(view);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Set(commandIds(fetchMock))).toHaveLength(1);
  });

  it("does not retry a conflict response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "Room revision changed", code: "REVISION_CONFLICT" }, 409));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendArenaCommand(credential, "pick", { cardKey: "knight", form: "base", expectedRevision: 1 }))
      .rejects.toMatchObject({ status: 409, code: "REVISION_CONFLICT" } satisfies Partial<ArenaApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
