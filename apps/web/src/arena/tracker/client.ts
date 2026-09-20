import type {
  ManualTrackerResultInput,
  ManualTrackerResultResponse,
  SocialCredential,
  TrackerSummary,
  TrackerSummaryResponse,
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

export const fetchTrackerSummary = async (credential: SocialCredential, signal?: AbortSignal): Promise<TrackerSummary> => {
  const response = await trackerRequest<TrackerSummaryResponse>("/summary", credential, { signal });
  if (!response || typeof response !== "object" || !response.summary || !Array.isArray(response.summary.players) || !Array.isArray(response.summary.recentGames)) {
    throw new Error("Game history returned an invalid response.");
  }
  return response.summary;
};

export const addManualTrackerResult = (credential: SocialCredential, input: ManualTrackerResultInput) =>
  trackerRequest<ManualTrackerResultResponse>("/manual", credential, { method: "POST", body: input });

export const undoManualTrackerResult = (credential: SocialCredential, battleId: string, commandId: string) =>
  trackerRequest<UndoManualTrackerResultResponse>(`/manual/${encodeURIComponent(battleId)}/undo`, credential, { method: "POST", body: { commandId } });

export const trackerCommandId = () => typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
