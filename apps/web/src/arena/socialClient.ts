import type {
  AcceptFriendLinkInput,
  ArenaCollection,
  ArenaSessionResponse,
  ArenaSettings,
  CreateFriendLinkInput,
  CreateSocialInviteInput,
  CreateSocialProfileInput,
  RespondSocialInviteInput,
  SocialCommandInput,
  SocialCredential,
  SocialFriendLinkResponse,
  SocialFriendResponse,
  SocialInviteResponse,
  SocialInviteSessionResponse,
  SocialProfileResponse,
  SocialSessionResponse,
  SocialState,
  SocialStateResponse,
  UpdateSocialProfileInput,
} from "@draft-royale/shared";

export class SocialApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

export interface StoredSocialIdentity {
  profileId?: string;
  token: string;
}

export interface SocialBootstrapResult {
  credential: SocialCredential;
  state: SocialState;
}

export type SocialIdentityInspection =
  | { status: "absent" | "malformed" | "unavailable"; identity: null }
  | { status: "valid"; identity: StoredSocialIdentity };

export const SOCIAL_IDENTITY_STORAGE_KEY = "draft-royale:social-profile";
const SOCIAL_BOOTSTRAP_LOCK = "draft-royale-social-profile-bootstrap";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isProfile = (value: unknown) => isObject(value) && isString(value.id) && isString(value.displayName) && isFiniteNumber(value.createdAt);
const isFriend = (value: unknown) => isObject(value) && isString(value.id) && isString(value.displayName) && isFiniteNumber(value.since);
const isSettings = (value: unknown) => isObject(value) && ["mega", "triple", "classic"].includes(String(value.mode)) && Number.isInteger(value.poolSize) && Number.isInteger(value.pickSeconds) && typeof value.specialForms === "boolean" && (value.mirrorMode === undefined || typeof value.mirrorMode === "boolean") && isString(value.battleMode);
const isInvite = (value: unknown) => isObject(value)
  && isString(value.id)
  && ["incoming", "outgoing"].includes(String(value.direction))
  && ["pending", "accepted", "declined", "canceled", "expired"].includes(String(value.status))
  && isObject(value.friend) && isString(value.friend.id) && isString(value.friend.displayName)
  && isSettings(value.settings) && isFiniteNumber(value.createdAt) && isFiniteNumber(value.expiresAt)
  && (value.respondedAt === null || isFiniteNumber(value.respondedAt));
const isSocialState = (value: unknown): value is SocialState => isObject(value)
  && isProfile(value.profile)
  && Array.isArray(value.friends) && value.friends.every(isFriend)
  && Array.isArray(value.incomingInvites) && value.incomingInvites.every(isInvite)
  && Array.isArray(value.outgoingInvites) && value.outgoingInvites.every(isInvite)
  && isFiniteNumber(value.serverNow);
const isSocialCredential = (value: unknown) => isObject(value) && isString(value.profileId) && typeof value.token === "string" && TOKEN_PATTERN.test(value.token);
const isArenaSession = (value: unknown): value is ArenaSessionResponse => {
  if (!isObject(value) || !isObject(value.credential) || !isObject(value.room)) return false;
  const credential = value.credential;
  const room = value.room;
  return isString(credential.roomId) && ["a", "b"].includes(String(credential.seat)) && isString(credential.token)
    && room.id === credential.roomId && room.viewer === credential.seat && Number.isInteger(room.revision)
    && ["waiting", "loading", "drafting", "complete"].includes(String(room.phase))
    && isSettings(room.settings) && Array.isArray(room.participants) && Array.isArray(room.board) && Array.isArray(room.events)
    && isFiniteNumber(room.serverNow);
};
const isStateResponse = (value: unknown): value is SocialStateResponse => isObject(value) && isSocialState(value.state);
const isProfileResponse = (value: unknown): value is SocialProfileResponse => isObject(value) && isObject(value.credential) && isSocialCredential(value.credential) && isSocialState(value.state) && value.state.profile.id === value.credential.profileId;
const isFriendLinkResponse = (value: unknown): value is SocialFriendLinkResponse => isObject(value) && isObject(value.friendLink)
  && typeof value.friendLink.token === "string" && TOKEN_PATTERN.test(value.friendLink.token)
  && isString(value.friendLink.path) && isFiniteNumber(value.friendLink.expiresAt);
const isFriendResponse = (value: unknown): value is SocialFriendResponse => isObject(value) && isFriend(value.friend) && isSocialState(value.state);
const isInviteResponse = (value: unknown): value is SocialInviteResponse => isObject(value) && isInvite(value.invite) && isSocialState(value.state);
const isInviteSessionResponse = (value: unknown): value is SocialInviteSessionResponse => isObject(value) && isInvite(value.invite) && isSocialState(value.state) && isArenaSession(value.session);
const isSessionResponse = (value: unknown): value is SocialSessionResponse => isObject(value) && isInvite(value.invite) && isArenaSession(value.session);

function requireShape<T>(value: unknown, guard: (candidate: unknown) => candidate is T, label: string): T {
  if (!guard(value)) throw new TypeError(`Friends returned an invalid ${label} response.`);
  return value;
}

export function parseStoredSocialIdentity(value: string | null): StoredSocialIdentity | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isObject(parsed) || typeof parsed.token !== "string" || !TOKEN_PATTERN.test(parsed.token)) return null;
    if (parsed.profileId !== undefined && (typeof parsed.profileId !== "string" || parsed.profileId.length === 0)) return null;
    return { token: parsed.token, ...(typeof parsed.profileId === "string" ? { profileId: parsed.profileId } : {}) };
  } catch {
    return null;
  }
}

export function inspectStoredSocialIdentity(): SocialIdentityInspection {
  try {
    const raw = window.localStorage.getItem(SOCIAL_IDENTITY_STORAGE_KEY);
    if (raw === null) return { status: "absent", identity: null };
    const identity = parseStoredSocialIdentity(raw);
    return identity ? { status: "valid", identity } : { status: "malformed", identity: null };
  } catch {
    return { status: "unavailable", identity: null };
  }
}

export const readSocialIdentity = () => inspectStoredSocialIdentity().identity;

export function writeSocialIdentity(identity: StoredSocialIdentity) {
  try { window.localStorage.setItem(SOCIAL_IDENTITY_STORAGE_KEY, JSON.stringify(identity)); }
  catch { throw new Error("Friends are unavailable because this browser blocks profile storage. Practice and room links still work."); }
}

/** Only call after a person explicitly chooses to start over. */
export function clearSocialIdentity() {
  try { window.localStorage.removeItem(SOCIAL_IDENTITY_STORAGE_KEY); }
  catch { throw new Error("This browser would not allow the saved friend profile to be replaced."); }
}

export function generateCredentialToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const socialCommandId = () => typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${generateCredentialToken().slice(0, 12)}`;

const friendlyMessage = (status: number, code: string | undefined, fallback: string) => {
  switch (code) {
    case "FRIEND_LINK_EXPIRED": return "That friend link expired. Ask your friend for a new one.";
    case "FRIEND_LINK_USED": return "That friend link was already used. Ask your friend for a new one.";
    case "SELF_CONNECTION": return "That link belongs to this friend profile.";
    case "INVITE_EXPIRED": return "That battle invitation expired.";
    case "INVALID_INVITE_STATE": return "That invitation was already answered or is no longer available.";
    case "NOT_FRIENDS": return "That friend connection no longer exists.";
    case "RATE_LIMITED": return "Too many requests at once. Wait a moment and try again.";
    case "UNAUTHORIZED": return "This browser's friend profile could not be restored.";
    default: return fallback || `Friends could not connect (${status}). Please try again.`;
  }
};

async function socialRequest<T>(path: string, options: { method?: "GET" | "POST" | "PATCH"; body?: unknown; credential?: StoredSocialIdentity } = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`/api/social${path}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.credential ? { Authorization: `Bearer ${options.credential.token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    let parsed: unknown;
    try { parsed = await response.json(); }
    catch (error) {
      if (response.ok) throw new TypeError("Friends returned an unreadable response.", { cause: error });
      parsed = {};
    }
    if (!response.ok) {
      const errorBody = isObject(parsed) ? parsed : {};
      const code = typeof errorBody.code === "string" ? errorBody.code : undefined;
      const fallback = typeof errorBody.error === "string" ? errorBody.error : "";
      throw new SocialApiError(friendlyMessage(response.status, code, fallback), response.status, code);
    }
    if (!isObject(parsed)) throw new TypeError("Friends returned an invalid response.");
    return parsed as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("Friends took too long to respond. Your saved profile is safe.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const isRetryable = (error: unknown) => !(error instanceof SocialApiError) || [408, 500, 502, 503, 504].includes(error.status);

async function retryMutation<T>(action: () => Promise<T>) {
  try { return await action(); }
  catch (error) {
    if (!isRetryable(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return action();
  }
}

const credentialOf = (identity: StoredSocialIdentity): SocialCredential => {
  if (!identity.profileId) throw new Error("This friend profile is still being restored.");
  return { profileId: identity.profileId, token: identity.token };
};

export const createSocialProfile = (input: CreateSocialProfileInput) => retryMutation(async () => requireShape(await socialRequest<unknown>("/profiles", { body: input }), isProfileResponse, "profile"));
export const getSocialState = async (identity: StoredSocialIdentity) => requireShape(await socialRequest<unknown>("/state", { credential: credentialOf(identity) }), isStateResponse, "state").state;
export const updateSocialProfile = (identity: StoredSocialIdentity, input: UpdateSocialProfileInput) => retryMutation(async () => requireShape(await socialRequest<unknown>("/profile", { method: "PATCH", body: input, credential: credentialOf(identity) }), isStateResponse, "profile"));
export const createSocialFriendLink = (identity: StoredSocialIdentity, input: CreateFriendLinkInput) => retryMutation(async () => requireShape(await socialRequest<unknown>("/friend-links", { body: input, credential: credentialOf(identity) }), isFriendLinkResponse, "friend link"));
export const acceptSocialFriendLink = (identity: StoredSocialIdentity, input: AcceptFriendLinkInput) => retryMutation(async () => requireShape(await socialRequest<unknown>("/friend-links/accept", { body: input, credential: credentialOf(identity) }), isFriendResponse, "friend"));
export const removeSocialFriend = (identity: StoredSocialIdentity, friendId: string, input: SocialCommandInput) => retryMutation(async () => requireShape(await socialRequest<unknown>(`/friends/${encodeURIComponent(friendId)}/remove`, { body: input, credential: credentialOf(identity) }), isStateResponse, "friends"));
export const createSocialInvite = (identity: StoredSocialIdentity, input: CreateSocialInviteInput) => retryMutation(async () => requireShape(await socialRequest<unknown>("/invites", { body: input, credential: credentialOf(identity) }), isInviteResponse, "invitation"));
export const acceptSocialInvite = (identity: StoredSocialIdentity, inviteId: string, input: RespondSocialInviteInput) => retryMutation(async () => requireShape(await socialRequest<unknown>(`/invites/${encodeURIComponent(inviteId)}/accept`, { body: input, credential: credentialOf(identity) }), isInviteSessionResponse, "accepted invitation"));
export const declineSocialInvite = (identity: StoredSocialIdentity, inviteId: string, input: SocialCommandInput) => retryMutation(async () => requireShape(await socialRequest<unknown>(`/invites/${encodeURIComponent(inviteId)}/decline`, { body: input, credential: credentialOf(identity) }), isInviteResponse, "declined invitation"));
export const cancelSocialInvite = (identity: StoredSocialIdentity, inviteId: string, input: SocialCommandInput) => retryMutation(async () => requireShape(await socialRequest<unknown>(`/invites/${encodeURIComponent(inviteId)}/cancel`, { body: input, credential: credentialOf(identity) }), isInviteResponse, "canceled invitation"));
export const getSocialInviteSession = (identity: StoredSocialIdentity, inviteId: string) => retryMutation(async () => requireShape(await socialRequest<unknown>(`/invites/${encodeURIComponent(inviteId)}/session`, { credential: credentialOf(identity) }), isSessionResponse, "invitation session"));

async function restoreOrCreate(displayName: string): Promise<SocialBootstrapResult> {
  const initial = inspectStoredSocialIdentity();
  if (initial.status === "unavailable") throw new Error("Friends are unavailable because this browser blocks profile storage. Practice and room links still work.");
  if (initial.status === "malformed") throw new SocialApiError("This browser's saved friend profile is damaged. Start a new profile to replace it.", 401, "MALFORMED_LOCAL_IDENTITY");
  let identity = initial.identity;
  if (!identity) {
    writeSocialIdentity({ token: generateCredentialToken() });
    const stored = inspectStoredSocialIdentity();
    if (stored.status === "unavailable") throw new Error("Friends are unavailable because this browser blocks profile storage. Practice and room links still work.");
    identity = stored.identity;
  }
  if (!identity) throw new Error("This browser could not save a friend profile.");
  if (identity.profileId) return { credential: credentialOf(identity), state: await getSocialState(identity) };

  const response = await createSocialProfile({ displayName, credentialToken: identity.token });
  const winner = readSocialIdentity();
  if (winner && winner.token !== identity.token) {
    // A no-Web-Locks storage race chose a different identity. Follow the stored winner and never write the loser back.
    return restoreOrCreate(displayName);
  }
  const credential = response.credential;
  writeSocialIdentity({ profileId: credential.profileId, token: credential.token });
  return { credential, state: response.state };
}

export async function bootstrapSocialProfile(displayName: string): Promise<SocialBootstrapResult> {
  const locks = navigator.locks;
  if (locks) return locks.request(SOCIAL_BOOTSTRAP_LOCK, { mode: "exclusive" }, () => restoreOrCreate(displayName));
  return restoreOrCreate(displayName);
}

export interface SocialBattleSnapshot {
  settings: ArenaSettings;
  collection: ArenaCollection;
}

export type SocialAcceptedSession = ArenaSessionResponse;
