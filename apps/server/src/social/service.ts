import { createHash, createHmac, randomBytes as cryptoRandomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ArenaCollection,
  ArenaSessionResponse,
  ArenaSettings,
  ArenaView,
  SocialFriend,
  SocialFriendLink,
  SocialInvite,
  SocialInviteSessionResponse,
  SocialProfile,
  SocialProfileResponse,
  SocialSessionResponse,
  SocialState,
} from "@draft-royale/shared";
import type { ArenaService } from "../arena/service.js";

export const SOCIAL_FRIEND_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const SOCIAL_INVITE_TTL_MS = 15 * 60 * 1_000;
const terminalInviteRetentionMs = 24 * 60 * 60 * 1_000;
const acceptedInviteRetentionMs = 7 * 24 * 60 * 60 * 1_000;
const maxFriends = 100;
const maxActiveFriendLinks = 10;
const maxPendingInvites = 20;

type ArenaSocialBridge = ArenaService & {
  normalizeSettings(input: unknown): ArenaSettings;
  normalizeCollection(input: unknown): ArenaCollection;
  rebindInvitedSeat(roomId: string, seat: "a" | "b", tokenHash: string): void;
  createInvitedRoom(input: {
    operationId: string;
    settings: ArenaSettings;
    host: { name: string; collection: ArenaCollection; tokenHash: string };
    guest: { name: string; collection: ArenaCollection; tokenHash: string };
    pairKey?: string;
  }): { roomId: string; hostRoom: ArenaView; guestRoom: ArenaView };
};

interface ProfileRow {
  id: string;
  display_name: string;
  token_hash: string;
  created_at: number;
}

interface FriendRow {
  id: string;
  display_name: string;
  created_at: number;
}

interface FriendLinkRow {
  id: string;
  owner_profile_id: string;
  expires_at: number;
  accepted_by: string | null;
  accepted_at: number | null;
}

interface InviteRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  status: SocialInvite["status"];
  settings_json: string;
  sender_collection_json: string;
  recipient_collection_json: string | null;
  sender_name: string;
  recipient_name: string;
  sender_room_token_hash: string;
  arena_room_id: string | null;
  created_at: number;
  expires_at: number;
  responded_at: number | null;
}

interface CommandRow {
  action: string;
  payload_hash: string;
  result_id: string;
}

export interface SocialServiceOptions {
  arena: ArenaSocialBridge;
  databasePath?: string;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

export interface AuthenticatedSocialProfile {
  profile: ProfileRow;
  token: string;
}

export interface SocialService {
  createProfile(input: { displayName: unknown; credentialToken?: unknown }): SocialProfileResponse & { created: boolean };
  authenticate(token: string): AuthenticatedSocialProfile;
  getState(auth: AuthenticatedSocialProfile): SocialState;
  updateProfile(auth: AuthenticatedSocialProfile, input: { displayName: unknown; commandId: unknown }): SocialState;
  createFriendLink(auth: AuthenticatedSocialProfile, input: { commandId: unknown }): SocialFriendLink;
  acceptFriendLink(auth: AuthenticatedSocialProfile, input: { token: unknown; commandId: unknown }): { friend: SocialFriend; state: SocialState };
  removeFriend(auth: AuthenticatedSocialProfile, friendId: unknown, input: { commandId: unknown }): SocialState;
  createInvite(auth: AuthenticatedSocialProfile, input: { friendId: unknown; settings: unknown; collection?: unknown; commandId: unknown }): { invite: SocialInvite; state: SocialState };
  acceptInvite(auth: AuthenticatedSocialProfile, inviteId: unknown, input: { collection?: unknown; commandId: unknown }): SocialInviteSessionResponse;
  declineInvite(auth: AuthenticatedSocialProfile, inviteId: unknown, input: { commandId: unknown }): { invite: SocialInvite; state: SocialState };
  cancelInvite(auth: AuthenticatedSocialProfile, inviteId: unknown, input: { commandId: unknown }): { invite: SocialInvite; state: SocialState };
  getInviteSession(auth: AuthenticatedSocialProfile, inviteId: unknown): SocialSessionResponse;
  addCredential(profileId: string, token: string, kind: string, expiresAt: number | null): void;
  retirePrimaryCredential(profileId: string, token: string, replacementHash: string, kind?: string, expiresAt?: number | null): boolean;
  revokeCredential(profileId: string, token: string): void;
  revokeCredentials(profileId: string, kind: string): void;
  /** Profiles the guard names keep the display name their account assigns; browser rename requests are ignored. */
  setDisplayNameGuard(guard: (profileId: string) => boolean): void;
  setDisplayName(profileId: string, displayName: string): void;
  ensureFriendship(leftProfileId: string, rightProfileId: string): boolean;
  deleteProfile(profileId: string): void;
  close(): void;
}

export class SocialError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) {
    super(message);
  }
}

const requireString = (value: unknown, label: string, max: number) => {
  if (typeof value !== "string") throw new SocialError(400, `${label} is required`, "INVALID_INPUT");
  const result = value.trim();
  if (!result || result.length > max) throw new SocialError(400, `${label} must be 1-${max} characters`, "INVALID_INPUT");
  return result;
};

const requireCommandId = (value: unknown) => requireString(value, "commandId", 100);
const requireId = (value: unknown, label: string) => requireString(value, label, 80);
const requireDisplayName = (value: unknown) => {
  const name = requireString(value, "displayName", 32);
  if (Array.from(name).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  })) throw new SocialError(400, "displayName cannot contain control characters", "INVALID_INPUT");
  return name;
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const payloadHash = (value: unknown) => sha256(JSON.stringify(value));
const clone = <T>(value: T): T => structuredClone(value);
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

const profileFromRow = (row: ProfileRow): SocialProfile => ({ id: row.id, displayName: row.display_name, createdAt: row.created_at });

const canonicalFriendIds = (left: string, right: string) => left < right ? [left, right] as const : [right, left] as const;

const parseJson = <T>(value: string, label: string): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new SocialError(500, `Stored ${label} is invalid`, "INVALID_SOCIAL_STATE");
  }
};

// Room seats are keyed to the profile, never to one sign-in session: a session token changes on every
// sign-in and differs per device, and a seat derived from it would lock its owner out of their own room.
export const deriveSocialRoomToken = (profileRoomKey: string, inviteId: string, seat: "a" | "b") =>
  `ars_${createHmac("sha256", profileRoomKey).update(`social-invite:${inviteId}:${seat}`).digest("base64url")}`;

export const createSocialService = (options: SocialServiceOptions): SocialService => {
  const now = options.now ?? Date.now;
  const random = options.randomBytes ?? cryptoRandomBytes;
  const databasePath = options.databasePath ?? path.resolve(process.cwd(), "data/private/arena.sqlite");
  if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS social_profile_credentials (
      token_hash TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER,
      FOREIGN KEY (profile_id) REFERENCES social_profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS social_profile_credentials_profile
      ON social_profile_credentials(profile_id, revoked_at, expires_at);
    CREATE TABLE IF NOT EXISTS social_profile_room_keys (
      profile_id TEXT PRIMARY KEY,
      room_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (profile_id) REFERENCES social_profiles(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS social_friend_links (
      id TEXT PRIMARY KEY,
      owner_profile_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      accepted_by TEXT,
      accepted_at INTEGER,
      FOREIGN KEY (owner_profile_id) REFERENCES social_profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (accepted_by) REFERENCES social_profiles(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS social_friendships (
      profile_low TEXT NOT NULL,
      profile_high TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (profile_low, profile_high),
      CHECK (profile_low < profile_high),
      FOREIGN KEY (profile_low) REFERENCES social_profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (profile_high) REFERENCES social_profiles(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS social_invites (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined','canceled','expired')),
      settings_json TEXT NOT NULL,
      sender_collection_json TEXT NOT NULL,
      recipient_collection_json TEXT,
      sender_name TEXT NOT NULL,
      recipient_name TEXT NOT NULL,
      sender_room_token_hash TEXT NOT NULL,
      arena_room_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      responded_at INTEGER,
      FOREIGN KEY (sender_id) REFERENCES social_profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (recipient_id) REFERENCES social_profiles(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS social_commands (
      profile_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      result_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (profile_id, command_id),
      FOREIGN KEY (profile_id) REFERENCES social_profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS social_invites_recipient ON social_invites(recipient_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS social_invites_sender ON social_invites(sender_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS social_invites_expiry ON social_invites(status, expires_at);
    CREATE INDEX IF NOT EXISTS social_friend_links_expiry ON social_friend_links(expires_at);
  `);

  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new SocialError(503, "Social service is closed", "SERVICE_CLOSED");
  };
  const makeToken = () => Buffer.from(random(32)).toString("base64url");
  const makeId = (prefix: string) => `${prefix}_${Buffer.from(random(16)).toString("base64url")}`;

  const transaction = <T>(operation: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const expirePending = () => {
    const timestamp = now();
    db.prepare("UPDATE social_invites SET status = 'expired', responded_at = expires_at WHERE status = 'pending' AND expires_at <= ?").run(timestamp);
  };

  const commandReplay = (profileId: string, commandId: string, action: string, hash: string) => {
    const row = db.prepare("SELECT action, payload_hash, result_id FROM social_commands WHERE profile_id = ? AND command_id = ?").get(profileId, commandId) as unknown as CommandRow | undefined;
    if (!row) return null;
    if (row.action !== action || row.payload_hash !== hash) throw new SocialError(409, "commandId was already used for a different action", "COMMAND_CONFLICT");
    return row.result_id;
  };

  const recordCommand = (profileId: string, commandId: string, action: string, hash: string, resultId: string) => {
    db.prepare("INSERT INTO social_commands(profile_id, command_id, action, payload_hash, result_id, created_at) VALUES(?,?,?,?,?,?)")
      .run(profileId, commandId, action, hash, resultId, now());
  };

  const profileRow = (profileId: string) => {
    const row = db.prepare("SELECT id, display_name, token_hash, created_at FROM social_profiles WHERE id = ?").get(profileId) as unknown as ProfileRow | undefined;
    if (!row) throw new SocialError(404, "Profile not found", "PROFILE_NOT_FOUND");
    return row;
  };

  const roomTokenFor = (profileId: string, inviteId: string, seat: "a" | "b") => {
    db.prepare("INSERT OR IGNORE INTO social_profile_room_keys(profile_id, room_key, created_at) VALUES(?,?,?)").run(profileId, makeToken(), now());
    const row = db.prepare("SELECT room_key FROM social_profile_room_keys WHERE profile_id = ?").get(profileId) as { room_key: string };
    return deriveSocialRoomToken(row.room_key, inviteId, seat);
  };

  const inviteRow = (inviteId: string) => {
    const row = db.prepare("SELECT * FROM social_invites WHERE id = ?").get(inviteId) as unknown as InviteRow | undefined;
    if (!row) throw new SocialError(404, "Battle invitation not found", "INVITE_NOT_FOUND");
    return row;
  };

  const projectInvite = (row: InviteRow, viewerId: string): SocialInvite => {
    const outgoing = row.sender_id === viewerId;
    if (!outgoing && row.recipient_id !== viewerId) throw new SocialError(403, "This invitation belongs to another profile", "INVITE_FORBIDDEN");
    return {
      id: row.id,
      direction: outgoing ? "outgoing" : "incoming",
      status: row.status,
      friend: outgoing
        ? { id: row.recipient_id, displayName: row.recipient_name }
        : { id: row.sender_id, displayName: row.sender_name },
      settings: clone(parseJson<ArenaSettings>(row.settings_json, "invitation settings")),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      respondedAt: row.responded_at,
      ...(row.arena_room_id ? { roomId: row.arena_room_id } : {}),
    };
  };

  const getState = (auth: AuthenticatedSocialProfile): SocialState => {
    ensureOpen();
    expirePending();
    const current = profileRow(auth.profile.id);
    const friends = db.prepare(`
      SELECT p.id, p.display_name, f.created_at
      FROM social_friendships f
      JOIN social_profiles p ON p.id = CASE WHEN f.profile_low = ? THEN f.profile_high ELSE f.profile_low END
      WHERE f.profile_low = ? OR f.profile_high = ?
      ORDER BY lower(p.display_name), p.id
    `).all(current.id, current.id, current.id) as unknown as FriendRow[];
    const cutoff = now() - terminalInviteRetentionMs;
    const acceptedCutoff = now() - acceptedInviteRetentionMs;
    const visibleSql = "(status = 'pending' OR (status = 'accepted' AND responded_at >= ?) OR (status != 'accepted' AND responded_at >= ?))";
    const incoming = db.prepare(`SELECT * FROM social_invites WHERE recipient_id = ? AND ${visibleSql} ORDER BY created_at DESC LIMIT 50`)
      .all(current.id, acceptedCutoff, cutoff) as unknown as InviteRow[];
    const outgoing = db.prepare(`SELECT * FROM social_invites WHERE sender_id = ? AND ${visibleSql} ORDER BY created_at DESC LIMIT 50`)
      .all(current.id, acceptedCutoff, cutoff) as unknown as InviteRow[];
    return {
      profile: profileFromRow(current),
      friends: friends.map((friend) => ({ id: friend.id, displayName: friend.display_name, since: friend.created_at })),
      incomingInvites: incoming.map((invite) => projectInvite(invite, current.id)),
      outgoingInvites: outgoing.map((invite) => projectInvite(invite, current.id)),
      serverNow: now(),
    };
  };

  const authenticate = (token: string): AuthenticatedSocialProfile => {
    ensureOpen();
    if (!token || token.length > 256) throw new SocialError(401, "Valid profile credentials are required", "UNAUTHORIZED");
    const tokenHash = sha256(token);
    const row = (db.prepare("SELECT id, display_name, token_hash, created_at FROM social_profiles WHERE token_hash = ?").get(tokenHash)
      ?? db.prepare(`SELECT p.id,p.display_name,p.token_hash,p.created_at
        FROM social_profile_credentials c JOIN social_profiles p ON p.id=c.profile_id
        WHERE c.token_hash=? AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>?)`).get(tokenHash, now())) as unknown as ProfileRow | undefined;
    if (!row) throw new SocialError(401, "Valid profile credentials are required", "UNAUTHORIZED");
    return { profile: row, token };
  };

  const createProfile = (input: { displayName: unknown; credentialToken?: unknown }) => {
    ensureOpen();
    const displayName = requireDisplayName(input.displayName);
    const token = input.credentialToken === undefined ? makeToken() : requireString(input.credentialToken, "credentialToken", 64);
    if (!tokenPattern.test(token)) throw new SocialError(400, "credentialToken must be 32 bytes of base64url data", "INVALID_INPUT");
    let existing = db.prepare("SELECT id, display_name, token_hash, created_at FROM social_profiles WHERE token_hash = ?").get(sha256(token)) as unknown as ProfileRow | undefined;
    if (existing) {
      const auth = { profile: existing, token };
      return { created: false, credential: { profileId: existing.id, token }, state: getState(auth) };
    }
    let id = "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = makeId("sp");
      if (!db.prepare("SELECT 1 FROM social_profiles WHERE id = ?").get(candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) throw new SocialError(503, "Could not allocate a profile", "PROFILE_UNAVAILABLE");
    const timestamp = now();
    try {
      db.prepare("INSERT INTO social_profiles(id, display_name, token_hash, created_at, updated_at) VALUES(?,?,?,?,?)")
        .run(id, displayName, sha256(token), timestamp, timestamp);
    } catch (error) {
      existing = db.prepare("SELECT id, display_name, token_hash, created_at FROM social_profiles WHERE token_hash = ?").get(sha256(token)) as unknown as ProfileRow | undefined;
      if (!existing) throw error;
      id = existing.id;
    }
    const profile = profileRow(id);
    const auth = { profile, token };
    return { created: !existing, credential: { profileId: profile.id, token }, state: getState(auth) };
  };

  const addCredential = (profileId: string, token: string, kind: string, expiresAt: number | null) => {
    ensureOpen();
    profileRow(profileId);
    if (!tokenPattern.test(token)) throw new SocialError(400, "credential token must be 32 bytes of base64url data", "INVALID_INPUT");
    db.prepare("INSERT INTO social_profile_credentials(token_hash,profile_id,kind,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,NULL)")
      .run(sha256(token), profileId, requireString(kind, "credential kind", 40), now(), expiresAt);
  };

  const retirePrimaryCredential = (profileId: string, token: string, replacementHash: string, kind?: string, expiresAt?: number | null) => {
    ensureOpen();
    const currentHash = sha256(token);
    const profile = profileRow(profileId);
    if (profile.token_hash !== currentHash) return false;
    transaction(() => {
      if (kind) db.prepare("INSERT OR IGNORE INTO social_profile_credentials(token_hash,profile_id,kind,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,NULL)")
        .run(currentHash, profileId, requireString(kind, "credential kind", 40), now(), expiresAt ?? null);
      db.prepare("UPDATE social_profiles SET token_hash=?,updated_at=? WHERE id=? AND token_hash=?").run(replacementHash, now(), profileId, currentHash);
    });
    return true;
  };

  const revokeCredential = (profileId: string, token: string) => {
    ensureOpen();
    db.prepare("UPDATE social_profile_credentials SET revoked_at=? WHERE profile_id=? AND token_hash=? AND revoked_at IS NULL")
      .run(now(), profileId, sha256(token));
  };

  const revokeCredentials = (profileId: string, kind: string) => {
    ensureOpen();
    db.prepare("UPDATE social_profile_credentials SET revoked_at=? WHERE profile_id=? AND kind=? AND revoked_at IS NULL")
      .run(now(), profileId, kind);
  };

  let displayNameGuard: (profileId: string) => boolean = () => false;
  const setDisplayName = (profileId: string, displayName: string) => {
    ensureOpen();
    const name = requireDisplayName(displayName);
    transaction(() => {
      db.prepare("UPDATE social_profiles SET display_name = ?, updated_at = ? WHERE id = ?").run(name, now(), profileId);
      db.prepare("UPDATE social_invites SET sender_name = ? WHERE sender_id = ?").run(name, profileId);
      db.prepare("UPDATE social_invites SET recipient_name = ? WHERE recipient_id = ?").run(name, profileId);
    });
  };
  const deleteProfile = (profileId: string) => {
    ensureOpen();
    db.prepare("DELETE FROM social_profiles WHERE id = ?").run(profileId);
  };
  const ensureFriendship = (leftProfileId: string, rightProfileId: string) => {
    ensureOpen();
    if (leftProfileId === rightProfileId) return false;
    profileRow(leftProfileId);
    profileRow(rightProfileId);
    const [low, high] = canonicalFriendIds(leftProfileId, rightProfileId);
    return db.prepare("INSERT OR IGNORE INTO social_friendships(profile_low, profile_high, created_at) VALUES(?,?,?)").run(low, high, now()).changes === 1;
  };

  const updateProfile = (auth: AuthenticatedSocialProfile, input: { displayName: unknown; commandId: unknown }) => {
    const displayName = requireDisplayName(input.displayName);
    const commandId = requireCommandId(input.commandId);
    if (displayNameGuard(auth.profile.id)) return getState(auth);
    const action = "profile.update";
    const hash = payloadHash({ displayName });
    transaction(() => {
      if (commandReplay(auth.profile.id, commandId, action, hash)) return;
      db.prepare("UPDATE social_profiles SET display_name = ?, updated_at = ? WHERE id = ?").run(displayName, now(), auth.profile.id);
      recordCommand(auth.profile.id, commandId, action, hash, auth.profile.id);
    });
    return getState(auth);
  };

  const createFriendLink = (auth: AuthenticatedSocialProfile, input: { commandId: unknown }): SocialFriendLink => {
    ensureOpen();
    const commandId = requireCommandId(input.commandId);
    const action = "friend-link.create";
    const hash = payloadHash({});
    const token = createHmac("sha256", auth.token).update(`friend-link:${commandId}`).digest("base64url");
    const id = makeId("fl");
    const expiresAt = now() + SOCIAL_FRIEND_LINK_TTL_MS;
    const resolvedExpiry = transaction(() => {
      const replay = commandReplay(auth.profile.id, commandId, action, hash);
      if (replay) {
        const row = db.prepare("SELECT id, owner_profile_id, expires_at, accepted_by, accepted_at FROM social_friend_links WHERE id = ?").get(replay) as unknown as FriendLinkRow | undefined;
        if (!row) throw new SocialError(500, "Saved friend link is missing", "INVALID_SOCIAL_STATE");
        return row.expires_at;
      }
      const activeLinks = Number((db.prepare("SELECT count(*) AS count FROM social_friend_links WHERE owner_profile_id = ? AND accepted_by IS NULL AND expires_at > ?").get(auth.profile.id, now()) as { count: number }).count);
      if (activeLinks >= maxActiveFriendLinks) throw new SocialError(409, "Too many active friend links", "FRIEND_LINK_LIMIT");
      db.prepare("INSERT INTO social_friend_links(id, owner_profile_id, token_hash, created_at, expires_at) VALUES(?,?,?,?,?)")
        .run(id, auth.profile.id, sha256(token), now(), expiresAt);
      recordCommand(auth.profile.id, commandId, action, hash, id);
      return expiresAt;
    });
    return { token, path: `/#friend=${encodeURIComponent(token)}`, expiresAt: resolvedExpiry };
  };

  const friendshipCount = (profileId: string) => Number((db.prepare("SELECT count(*) AS count FROM social_friendships WHERE profile_low = ? OR profile_high = ?").get(profileId, profileId) as { count: number }).count);

  const acceptFriendLink = (auth: AuthenticatedSocialProfile, input: { token: unknown; commandId: unknown }) => {
    ensureOpen();
    const token = requireString(input.token, "friend link", 128);
    const commandId = requireCommandId(input.commandId);
    const action = "friend-link.accept";
    const hash = payloadHash({ tokenHash: sha256(token) });
    const accepted = transaction(() => {
      const replay = commandReplay(auth.profile.id, commandId, action, hash);
      if (replay) {
        const friend = profileRow(replay);
        const [low, high] = canonicalFriendIds(auth.profile.id, friend.id);
        const relation = db.prepare("SELECT created_at FROM social_friendships WHERE profile_low = ? AND profile_high = ?").get(low, high) as { created_at: number } | undefined;
        if (!relation) throw new SocialError(409, "This friendship was removed", "NOT_FRIENDS");
        return { friend, since: relation.created_at };
      }
      const link = db.prepare("SELECT id, owner_profile_id, expires_at, accepted_by, accepted_at FROM social_friend_links WHERE token_hash = ?").get(sha256(token)) as unknown as FriendLinkRow | undefined;
      if (!link) throw new SocialError(404, "Friend link not found", "FRIEND_LINK_NOT_FOUND");
      if (link.owner_profile_id === auth.profile.id) throw new SocialError(409, "You cannot use your own friend link", "SELF_CONNECTION");
      if (link.accepted_by) throw new SocialError(409, "This friend link was already used", "FRIEND_LINK_USED");
      if (link.expires_at <= now()) throw new SocialError(410, "This friend link expired", "FRIEND_LINK_EXPIRED");
      const friend = profileRow(link.owner_profile_id);
      const [low, high] = canonicalFriendIds(auth.profile.id, friend.id);
      const existing = db.prepare("SELECT created_at FROM social_friendships WHERE profile_low = ? AND profile_high = ?").get(low, high) as { created_at: number } | undefined;
      if (!existing && (friendshipCount(auth.profile.id) >= maxFriends || friendshipCount(friend.id) >= maxFriends)) {
        throw new SocialError(409, "A profile has reached the friend limit", "FRIEND_LIMIT");
      }
      const since = existing?.created_at ?? now();
      const claim = db.prepare("UPDATE social_friend_links SET accepted_by = ?, accepted_at = ? WHERE id = ? AND accepted_by IS NULL").run(auth.profile.id, now(), link.id);
      if (claim.changes !== 1) throw new SocialError(409, "This friend link was already used", "FRIEND_LINK_USED");
      db.prepare("INSERT OR IGNORE INTO social_friendships(profile_low, profile_high, created_at) VALUES(?,?,?)").run(low, high, since);
      recordCommand(auth.profile.id, commandId, action, hash, friend.id);
      return { friend, since };
    });
    return { friend: { id: accepted.friend.id, displayName: accepted.friend.display_name, since: accepted.since }, state: getState(auth) };
  };

  const removeFriend = (auth: AuthenticatedSocialProfile, rawFriendId: unknown, input: { commandId: unknown }) => {
    ensureOpen();
    const friendId = requireId(rawFriendId, "friendId");
    const commandId = requireCommandId(input.commandId);
    const action = `friend.remove:${friendId}`;
    const hash = payloadHash({ friendId });
    transaction(() => {
      if (commandReplay(auth.profile.id, commandId, action, hash)) return;
      profileRow(friendId);
      const [low, high] = canonicalFriendIds(auth.profile.id, friendId);
      const relation = db.prepare("SELECT 1 FROM social_friendships WHERE profile_low = ? AND profile_high = ?").get(low, high);
      if (!relation) throw new SocialError(409, "These profiles are not friends", "NOT_FRIENDS");
      db.prepare("DELETE FROM social_friendships WHERE profile_low = ? AND profile_high = ?").run(low, high);
      db.prepare("UPDATE social_invites SET status = 'canceled', responded_at = ? WHERE status = 'pending' AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))")
        .run(now(), auth.profile.id, friendId, friendId, auth.profile.id);
      recordCommand(auth.profile.id, commandId, action, hash, friendId);
    });
    return getState(auth);
  };

  const createInvite = (auth: AuthenticatedSocialProfile, input: { friendId: unknown; settings: unknown; collection?: unknown; commandId: unknown }) => {
    ensureOpen();
    expirePending();
    const friendId = requireId(input.friendId, "friendId");
    const commandId = requireCommandId(input.commandId);
    const settings = options.arena.normalizeSettings(input.settings);
    const collection = options.arena.normalizeCollection(input.collection);
    const action = "invite.create";
    const hash = payloadHash({ friendId, settings, collection });
    const id = makeId("si");
    const timestamp = now();
    const expiresAt = timestamp + SOCIAL_INVITE_TTL_MS;
    const senderRoomTokenHash = sha256(roomTokenFor(auth.profile.id, id, "a"));
    const resolvedId = transaction(() => {
      const replay = commandReplay(auth.profile.id, commandId, action, hash);
      if (replay) return replay;
      const friend = profileRow(friendId);
      const [low, high] = canonicalFriendIds(auth.profile.id, friendId);
      if (!db.prepare("SELECT 1 FROM social_friendships WHERE profile_low = ? AND profile_high = ?").get(low, high)) {
        throw new SocialError(409, "Battle invitations can only be sent to friends", "NOT_FRIENDS");
      }
      const pending = Number((db.prepare("SELECT count(*) AS count FROM social_invites WHERE sender_id = ? AND status = 'pending'").get(auth.profile.id) as { count: number }).count);
      if (pending >= maxPendingInvites) throw new SocialError(409, "Too many pending battle invitations", "PENDING_INVITE_LIMIT");
      if (db.prepare("SELECT 1 FROM social_invites WHERE status = 'pending' AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))").get(auth.profile.id, friendId, friendId, auth.profile.id)) {
        throw new SocialError(409, "There is already a pending battle invitation between these friends", "INVITE_ALREADY_PENDING");
      }
      db.prepare(`INSERT INTO social_invites(
        id, sender_id, recipient_id, status, settings_json, sender_collection_json,
        sender_name, recipient_name, sender_room_token_hash, created_at, expires_at
      ) VALUES(?,?,?,'pending',?,?,?,?,?,?,?)`).run(
        id, auth.profile.id, friend.id, JSON.stringify(settings), JSON.stringify(collection),
        auth.profile.display_name, friend.display_name, senderRoomTokenHash, timestamp, expiresAt,
      );
      recordCommand(auth.profile.id, commandId, action, hash, id);
      return id;
    });
    const invite = projectInvite(inviteRow(resolvedId), auth.profile.id);
    return { invite, state: getState(auth) };
  };

  const sessionFor = (auth: AuthenticatedSocialProfile, row: InviteRow): ArenaSessionResponse => {
    if (row.status !== "accepted" || !row.arena_room_id) throw new SocialError(409, "This invitation does not have an active room", "INVALID_INVITE_STATE");
    const seat = row.sender_id === auth.profile.id ? "a" : row.recipient_id === auth.profile.id ? "b" : null;
    if (!seat) throw new SocialError(403, "This invitation belongs to another profile", "INVITE_FORBIDDEN");
    const token = roomTokenFor(auth.profile.id, row.id, seat);
    const roomId = row.arena_room_id;
    const statusOf = (error: unknown) => (error as { status?: unknown } | null)?.status;
    try {
      let room: ArenaView;
      try { room = options.arena.getView(roomId, token); }
      catch (error) {
        if (statusOf(error) !== 401) throw error;
        // Rooms opened before seats were profile-keyed still hold a hash of an old sign-in token.
        options.arena.rebindInvitedSeat(roomId, seat, sha256(token));
        room = options.arena.getView(roomId, token);
      }
      return { credential: { roomId, seat, token }, room };
    } catch (error) {
      // A room problem is never a sign-in problem; a 401 here would make the browser distrust a valid login.
      if ([401, 404, 410].includes(Number(statusOf(error)))) throw new SocialError(410, "This battle room is no longer available", "INVITE_ROOM_UNAVAILABLE");
      throw error;
    }
  };

  const acceptInvite = (auth: AuthenticatedSocialProfile, rawInviteId: unknown, input: { collection?: unknown; commandId: unknown }): SocialInviteSessionResponse => {
    ensureOpen();
    expirePending();
    const inviteId = requireId(rawInviteId, "inviteId");
    const commandId = requireCommandId(input.commandId);
    const collection = options.arena.normalizeCollection(input.collection);
    const action = `invite.accept:${inviteId}`;
    const hash = payloadHash({ inviteId, collection });
    const replay = commandReplay(auth.profile.id, commandId, action, hash);
    if (replay) {
      const row = inviteRow(replay);
      return { invite: projectInvite(row, auth.profile.id), state: getState(auth), session: sessionFor(auth, row) };
    }
    let row = inviteRow(inviteId);
    if (row.recipient_id !== auth.profile.id) throw new SocialError(403, "Only the recipient can accept this invitation", "INVITE_FORBIDDEN");
    if (row.status === "pending" && row.expires_at <= now()) {
      db.prepare("UPDATE social_invites SET status = 'expired', responded_at = expires_at WHERE id = ? AND status = 'pending'").run(row.id);
      throw new SocialError(410, "This battle invitation expired", "INVITE_EXPIRED");
    }
    if (row.status === "expired") throw new SocialError(410, "This battle invitation expired", "INVITE_EXPIRED");
    if (row.status !== "pending") throw new SocialError(409, "This invitation can no longer be accepted", "INVALID_INVITE_STATE");
    const settings = parseJson<ArenaSettings>(row.settings_json, "invitation settings");
    const senderCollection = parseJson<ArenaCollection>(row.sender_collection_json, "sender collection");
    const guestToken = roomTokenFor(auth.profile.id, row.id, "b");
    const room = options.arena.createInvitedRoom({
      operationId: row.id,
      pairKey: sha256(JSON.stringify(canonicalFriendIds(row.sender_id, row.recipient_id))),
      settings,
      host: { name: row.sender_name, collection: senderCollection, tokenHash: row.sender_room_token_hash },
      guest: { name: row.recipient_name, collection, tokenHash: sha256(guestToken) },
    });
    transaction(() => {
      const concurrentReplay = commandReplay(auth.profile.id, commandId, action, hash);
      if (concurrentReplay) return;
      const current = inviteRow(row.id);
      if (current.status !== "pending" && !(current.status === "accepted" && current.arena_room_id === room.roomId)) {
        throw new SocialError(409, "This invitation changed while it was being accepted", "INVALID_INVITE_STATE");
      }
      if (current.status === "pending") db.prepare("UPDATE social_invites SET status = 'accepted', recipient_collection_json = ?, arena_room_id = ?, responded_at = ? WHERE id = ?")
        .run(JSON.stringify(collection), room.roomId, now(), row.id);
      recordCommand(auth.profile.id, commandId, action, hash, row.id);
    });
    row = inviteRow(row.id);
    const session: ArenaSessionResponse = { credential: { roomId: room.roomId, seat: "b", token: guestToken }, room: room.guestRoom };
    return { invite: projectInvite(row, auth.profile.id), state: getState(auth), session };
  };

  const transitionInvite = (auth: AuthenticatedSocialProfile, rawInviteId: unknown, input: { commandId: unknown }, transition: "declined" | "canceled") => {
    ensureOpen();
    expirePending();
    const inviteId = requireId(rawInviteId, "inviteId");
    const commandId = requireCommandId(input.commandId);
    const action = `invite.${transition}:${inviteId}`;
    const hash = payloadHash({ inviteId });
    const resolvedId = transaction(() => {
      const replay = commandReplay(auth.profile.id, commandId, action, hash);
      if (replay) return replay;
      const row = inviteRow(inviteId);
      const allowed = transition === "declined" ? row.recipient_id === auth.profile.id : row.sender_id === auth.profile.id;
      if (!allowed) throw new SocialError(403, `Only the ${transition === "declined" ? "recipient" : "sender"} can ${transition === "declined" ? "decline" : "cancel"} this invitation`, "INVITE_FORBIDDEN");
      if (row.status === "expired") throw new SocialError(410, "This battle invitation expired", "INVITE_EXPIRED");
      if (row.status !== "pending") throw new SocialError(409, "This invitation can no longer change", "INVALID_INVITE_STATE");
      db.prepare("UPDATE social_invites SET status = ?, responded_at = ? WHERE id = ? AND status = 'pending'").run(transition, now(), row.id);
      recordCommand(auth.profile.id, commandId, action, hash, row.id);
      return row.id;
    });
    const updated = inviteRow(resolvedId);
    return { invite: projectInvite(updated, auth.profile.id), state: getState(auth) };
  };

  const getInviteSession = (auth: AuthenticatedSocialProfile, rawInviteId: unknown): SocialSessionResponse => {
    ensureOpen();
    const row = inviteRow(requireId(rawInviteId, "inviteId"));
    return { invite: projectInvite(row, auth.profile.id), session: sessionFor(auth, row) };
  };

  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
  };

  return {
    createProfile,
    authenticate,
    addCredential,
    retirePrimaryCredential,
    revokeCredential,
    revokeCredentials,
    setDisplayNameGuard: (guard) => { displayNameGuard = guard; },
    setDisplayName,
    ensureFriendship,
    deleteProfile,
    getState,
    updateProfile,
    createFriendLink,
    acceptFriendLink,
    removeFriend,
    createInvite,
    acceptInvite,
    declineInvite: (auth, inviteId, input) => transitionInvite(auth, inviteId, input, "declined"),
    cancelInvite: (auth, inviteId, input) => transitionInvite(auth, inviteId, input, "canceled"),
    getInviteSession,
    close,
  };
};
