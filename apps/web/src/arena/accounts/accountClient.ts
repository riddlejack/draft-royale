import type { ArenaCollection, ArenaCollectionImportResponse, SocialCredential } from "@draft-royale/shared";
import { readSocialIdentity } from "../socialClient";

export interface ClubAccount {
  username: string;
  displayName: string;
  tag: string | null;
  profileId: string;
  providers: string[];
  passwordEnabled: boolean;
}

export interface AccountSession {
  account: ClubAccount;
  collection: ArenaCollection | null;
  credential?: SocialCredential;
  recoveryCode?: string;
  expiresAt?: string;
}

export interface ProviderConfig {
  google: { enabled: boolean; clientId?: string };
  apple: { enabled: boolean; reason?: string };
}

export class AccountApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

async function accountRequest<T>(path: string, options: { method?: "GET" | "POST" | "PATCH" | "PUT"; body?: unknown; token?: string } = {}) {
  const response = await fetch(`/api/accounts${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(15_000),
  });
  let parsed: unknown;
  try { parsed = await response.json(); }
  catch { parsed = {}; }
  if (!response.ok) {
    const body = isObject(parsed) ? parsed : {};
    throw new AccountApiError(typeof body.error === "string" ? body.error : "The account request failed.", response.status, typeof body.code === "string" ? body.code : undefined);
  }
  return parsed as T;
}

export const rememberedAccount = (): ClubAccount | null => {
  try {
    const raw = JSON.parse(localStorage.getItem("draft-royale:account") ?? "null") as ClubAccount | null;
    return raw && raw.profileId === readSocialIdentity()?.profileId ? raw : null;
  } catch { return null; }
};

export const rememberAccount = (account: ClubAccount) => {
  try { localStorage.setItem("draft-royale:account", JSON.stringify(account)); } catch { /* The server session remains authoritative. */ }
};
export const forgetAccount = () => {
  try { localStorage.removeItem("draft-royale:account"); } catch { /* Best effort. */ }
};
export const collectionStorageKey = (profileId: string) => `collection:${profileId}`;
export const collectionDirtyKey = (profileId: string) => `collection-dirty:${profileId}`;

export const getProviderConfig = () => accountRequest<ProviderConfig>("/providers");
export const getAccountSession = (token: string) => accountRequest<AccountSession>("/session", { token });
export const loginAccount = (username: string, password: string) => accountRequest<AccountSession>("/login", { body: { username, password } });
export const registerAccount = (displayName: string, password: string) => accountRequest<AccountSession>("/register", { body: { displayName, password } });
export const recoverAccount = (username: string, recoveryCode: string, newPassword: string) => accountRequest<AccountSession>("/recover", { body: { username, recoveryCode, newPassword } });
export const logoutAccount = (token: string) => accountRequest<{ ok: true }>("/logout", { body: {}, token });
export const updateAccountTag = (token: string, tag: string | null) => accountRequest<{ account: ClubAccount }>("/profile", { method: "PATCH", body: { tag }, token });
export const saveAccountCollection = (token: string, collection: ArenaCollection) => accountRequest<{ collection: ArenaCollection }>("/collection", { method: "PUT", body: { collection }, token });
export const importAccountCollection = (token: string) => accountRequest<ArenaCollectionImportResponse>("/collection/import", { body: {}, token });
export const createGoogleChallenge = () => accountRequest<{ state: string; nonce: string; expiresAt: string }>("/google/challenge", { body: {} });
export const finishGoogleSignIn = (credential: string, state: string, token?: string) => accountRequest<AccountSession>("/google", {
  body: { credential, state, ...(token ? { action: "link" } : {}) }, token,
});
