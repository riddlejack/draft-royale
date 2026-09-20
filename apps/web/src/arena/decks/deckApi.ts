import type { DeckDefinition, SocialCredential } from "@draft-royale/shared";

export async function libraryRequest<T>(path: string, credential?: SocialCredential | null, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api/decks${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(credential ? { Authorization: `Bearer ${credential.token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Your library could not connect. Try again.");
  return data as T;
}
export const persistDeck = (deck: DeckDefinition, visibility: "private" | "public", credential: SocialCredential, commandId: string) =>
  libraryRequest<{ deck: DeckDefinition }>("", credential, { deck, visibility, commandId });
