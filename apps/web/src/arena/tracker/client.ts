import type {
  ManualTrackerResultInput,
  ManualTrackerResultResponse,
  SocialCredential,
  TrackerDeckLog,
  TrackerDeckLogResponse,
  TrackerSummary,
  TrackerSummaryResponse,
  TrackerFilters,
  TrackerPollStatus,
  UndoManualTrackerResultResponse,
} from "@draft-royale/shared";

export class TrackerApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

const trackerRequest = async <T>(path: string, credential: SocialCredential, options: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {}) => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    const response = await fetch(`/api/tracker${path}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${credential.token}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    let parsed: unknown;
    try { parsed = await response.json(); }
    catch { parsed = {}; }
    if (!response.ok) {
      const error = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
      throw new TrackerApiError(typeof error.error === "string" ? error.error : "Game history could not load", response.status, typeof error.code === "string" ? error.code : undefined);
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof TrackerApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("Game history took too long to respond.");
    throw new Error("Game history could not connect.", { cause: error });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
};

export const fetchTrackerSummary = async (credential: SocialCredential, filters: Partial<TrackerFilters> = {}, signal?: AbortSignal): Promise<TrackerSummary> => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (typeof value === "string" && value) search.set(key, value);
  const response = await trackerRequest<TrackerSummaryResponse>(`/summary${search.size ? `?${search}` : ""}`, credential, { signal });
  if (!response || typeof response !== "object" || !response.summary || !Array.isArray(response.summary.players) || !Array.isArray(response.summary.recentGames)) {
    throw new Error("Game history returned an invalid response.");
  }
  return response.summary;
};

export const fetchTrackerDeckLog = async (credential: SocialCredential, playerTag = "", signal?: AbortSignal): Promise<TrackerDeckLog> => {
  const response = await trackerRequest<TrackerDeckLogResponse>(`/decks${playerTag ? `?${new URLSearchParams({ playerTag })}` : ""}`, credential, { signal });
  if (!response || typeof response !== "object" || !response.deckLog || !Array.isArray(response.deckLog.decks) || !Array.isArray(response.deckLog.players)) throw new Error("Played decks returned an invalid response.");
  return response.deckLog;
};

export const requestTrackerSync = async (credential: SocialCredential, playerTag: string) => {
  const response = await trackerRequest<{ status: TrackerPollStatus }>("/sync", credential, { method: "POST", body: { playerTag } });
  return response.status;
};

export const addManualTrackerResult = (credential: SocialCredential, input: ManualTrackerResultInput) =>
  trackerRequest<ManualTrackerResultResponse>("/manual", credential, { method: "POST", body: input });

export const undoManualTrackerResult = (credential: SocialCredential, battleId: string, commandId: string) =>
  trackerRequest<UndoManualTrackerResultResponse>(`/manual/${encodeURIComponent(battleId)}/undo`, credential, { method: "POST", body: { commandId } });

export const trackerCommandId = () => typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
