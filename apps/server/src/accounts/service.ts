import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { OAuth2Client } from "google-auth-library";
import type { ArenaCollection } from "@draft-royale/shared";
import type { SocialService } from "../social/service.js";

const ACCOUNT_SCHEMA_VERSION = 2;
const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1_000;
const GOOGLE_CHALLENGE_TTL_MS = 10 * 60 * 1_000;

export class AccountError extends Error {
  constructor(readonly status: number, message: string, readonly code = "ACCOUNT_ERROR") { super(message); }
}

export interface ClubAccount {
  username: string;
  displayName: string;
  tag: string | null;
  profileId: string;
  providers: string[];
  passwordEnabled: boolean;
}

interface AccountRow {
  username: string;
  display_name: string;
  tag: string | null;
  salt: string;
  password_hash: string;
  profile_id: string;
  password_version: number;
  credential_version: number;
  password_enabled: number;
  collection_json: string | null;
  collection_updated_at: number | null;
  created_at: number;
}

export interface GoogleClaims {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

export interface AccountServiceOptions {
  databasePath: string;
  social: SocialService;
  normalizeCollection: (input: unknown) => ArenaCollection;
  now?: () => number;
  googleClientId?: string;
  /**
   * Player tags whose accounts are friends with each other automatically. Only the first account to
   * track a tag counts, so tracking a friend's public tag never grants access to their friends list.
   */
  clubTags?: readonly string[];
  verifyGoogleIdToken?: (idToken: string, audience: string) => Promise<GoogleClaims>;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const sameHex = (left: string, right: string) => {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};
const nameOf = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_ .-]{2,32}$/.test(value.trim())) {
    throw new AccountError(400, "Use a player name with 2–32 letters, numbers, spaces, or underscores.", "INVALID_NAME");
  }
  return value.trim();
};
const providerNameOf = (value: unknown) => {
  if (typeof value !== "string") return "Player";
  const cleaned = Array.from(value.trim()).filter((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point > 31 && point !== 127;
  }).join("").slice(0, 32);
  return cleaned.length >= 2 ? cleaned : "Player";
};
const tagOf = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new AccountError(400, "Enter a Clash Royale player tag.", "INVALID_PLAYER_TAG");
  const tag = `#${value.replace(/^#/, "").replace(/\s+/g, "").trim().toUpperCase().replace(/O/g, "0")}`;
  if (!/^#[0289PYLQGRJCUV]{3,15}$/.test(tag)) throw new AccountError(400, "Enter a valid Clash Royale tag, such as #P0LYQ.", "INVALID_PLAYER_TAG");
  return tag;
};
const passwordOf = (value: unknown, displayName?: string) => {
  if (typeof value !== "string" || value.length < 12 || value.length > 128) throw new AccountError(400, "Use a password with 12–128 characters.", "INVALID_PASSWORD");
  if (displayName && value.toLocaleLowerCase() === displayName.toLocaleLowerCase()) throw new AccountError(400, "Your password cannot be your player name.", "INVALID_PASSWORD");
  return value;
};
const parseCollection = (value: string | null): ArenaCollection | null => {
  if (!value) return null;
  try { return JSON.parse(value) as ArenaCollection; }
  catch { throw new AccountError(500, "The saved collection is unreadable.", "INVALID_ACCOUNT_STATE"); }
};

export function createAccountService(options: AccountServiceOptions) {
  const now = options.now ?? Date.now;
  const db = new DatabaseSync(options.databasePath);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec("CREATE TABLE IF NOT EXISTS club_account_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  db.prepare("INSERT OR IGNORE INTO club_account_meta VALUES('identity_secret',?)").run(randomBytes(32).toString("hex"));
  const secret = String(db.prepare("SELECT value FROM club_account_meta WHERE key='identity_secret'").get()?.value);

  const tableExists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='club_accounts'").get());
  const schemaVersion = Number(db.prepare("SELECT value FROM club_account_meta WHERE key='account_schema_version'").get()?.value ?? 0);
  if (!tableExists) {
    db.exec(`CREATE TABLE club_accounts (
      username TEXT PRIMARY KEY, display_name TEXT NOT NULL, tag TEXT, salt TEXT NOT NULL,
      password_hash TEXT NOT NULL, profile_id TEXT NOT NULL UNIQUE,
      password_version INTEGER NOT NULL DEFAULT 1, credential_version INTEGER NOT NULL DEFAULT 1,
      password_enabled INTEGER NOT NULL DEFAULT 1, collection_json TEXT,
      collection_updated_at INTEGER, created_at INTEGER NOT NULL
    );`);
  } else if (schemaVersion < ACCOUNT_SCHEMA_VERSION) {
    const columns = new Set((db.prepare("PRAGMA table_info(club_accounts)").all() as Array<{ name: string }>).map((column) => column.name));
    const expression = (column: string, fallback: string) => columns.has(column) ? column : fallback;
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec("ALTER TABLE club_accounts RENAME TO club_accounts_legacy;");
      db.exec(`CREATE TABLE club_accounts (
        username TEXT PRIMARY KEY, display_name TEXT NOT NULL, tag TEXT, salt TEXT NOT NULL,
        password_hash TEXT NOT NULL, profile_id TEXT NOT NULL UNIQUE,
        password_version INTEGER NOT NULL DEFAULT 1, credential_version INTEGER NOT NULL DEFAULT 1,
        password_enabled INTEGER NOT NULL DEFAULT 1, collection_json TEXT,
        collection_updated_at INTEGER, created_at INTEGER NOT NULL
      );`);
      const migrate = db.prepare(`INSERT INTO club_accounts(username,display_name,tag,salt,password_hash,profile_id,password_version,credential_version,password_enabled,collection_json,collection_updated_at,created_at)
        SELECT username,display_name,tag,salt,password_hash,profile_id,
          ${expression("password_version", "0")},${expression("credential_version", "0")},
          ${expression("password_enabled", "1")},${expression("collection_json", "NULL")},
          ${expression("collection_updated_at", "NULL")},${expression("created_at", "?")}
        FROM club_accounts_legacy`);
      if (columns.has("created_at")) migrate.run(); else migrate.run(now());
      db.exec("DROP TABLE club_accounts_legacy;");
      db.exec("COMMIT;");
    } catch (error) { db.exec("ROLLBACK;"); throw error; }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS club_accounts_tag ON club_accounts(tag);
    CREATE TABLE IF NOT EXISTS account_sessions (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS account_sessions_profile ON account_sessions(profile_id, revoked_at, expires_at);
    CREATE TABLE IF NOT EXISTS account_recovery (
      profile_id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, generation INTEGER NOT NULL,
      created_at INTEGER NOT NULL, used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS account_providers (
      provider TEXT NOT NULL, subject TEXT NOT NULL, profile_id TEXT NOT NULL,
      email TEXT, display_name TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY(provider, subject), UNIQUE(profile_id, provider)
    );
    CREATE TABLE IF NOT EXISTS account_google_challenges (
      state_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, consumed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS account_google_challenges_expiry ON account_google_challenges(expires_at, consumed_at);
    CREATE TABLE IF NOT EXISTS account_reset_claims (
      profile_id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, consumed_at INTEGER
    );
  `);
  db.prepare("INSERT INTO club_account_meta(key,value) VALUES('account_schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(ACCOUNT_SCHEMA_VERSION));

  const credentialFor = (username: string, version: number) => createHmac("sha256", secret)
    .update(version < 1 ? `club-profile:${username}` : `club-profile:${username}:v${version}`).digest("base64url");
  // This is deliberately random and never exposed as a token. A copied database
  // includes identity_secret, so a deterministic "disabled" bearer is still derivable.
  const disabledCredentialHash = () => randomBytes(32).toString("hex");
  const rows = () => db.prepare("SELECT * FROM club_accounts ORDER BY rowid").all() as unknown as AccountRow[];
  const rowForProfile = (profileId: string) => db.prepare("SELECT * FROM club_accounts WHERE profile_id=?").get(profileId) as unknown as AccountRow | undefined;
  const rowForUsername = (username: string) => db.prepare("SELECT * FROM club_accounts WHERE username=?").get(username) as unknown as AccountRow | undefined;
  const providersFor = (profileId: string) => (db.prepare("SELECT provider FROM account_providers WHERE profile_id=? ORDER BY provider").all(profileId) as Array<{ provider: string }>).map((row) => row.provider);
  const accountOf = (row: AccountRow): ClubAccount => ({
    username: row.username, displayName: row.display_name, tag: row.tag, profileId: row.profile_id,
    providers: providersFor(row.profile_id), passwordEnabled: Boolean(row.password_enabled && row.password_version >= 1),
  });

  // Convert the former deterministic account bearer into an ordinary revocable session.
  for (const row of rows()) {
    const expectedToken = credentialFor(row.username, row.credential_version);
    // A copied legacy database contains the HMAC secret, so never carry its deterministic bearer forward.
    options.social.retirePrimaryCredential(row.profile_id, expectedToken, disabledCredentialHash());
  }

  const recoveryHash = (code: string) => createHmac("sha256", secret).update(`account-recovery:${code}`).digest("hex");
  const createRecovery = (profileId: string) => {
    const code = `DR-${randomBytes(12).toString("hex").toUpperCase().match(/.{1,4}/g)!.join("-")}`;
    const previous = db.prepare("SELECT generation FROM account_recovery WHERE profile_id=?").get(profileId) as { generation: number } | undefined;
    db.prepare(`INSERT INTO account_recovery(profile_id,code_hash,generation,created_at,used_at) VALUES(?,?,?,?,NULL)
      ON CONFLICT(profile_id) DO UPDATE SET code_hash=excluded.code_hash,generation=excluded.generation,created_at=excluded.created_at,used_at=NULL`)
      .run(profileId, recoveryHash(code), (previous?.generation ?? 0) + 1, now());
    return code;
  };

  const issueSession = (row: AccountRow) => {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = sha256(token);
    const createdAt = now();
    const expiresAt = createdAt + SESSION_TTL_MS;
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare("INSERT INTO account_sessions(id,profile_id,token_hash,created_at,expires_at,last_used_at) VALUES(?,?,?,?,?,?)")
        .run(`as_${randomBytes(16).toString("base64url")}`, row.profile_id, tokenHash, createdAt, expiresAt, createdAt);
      db.exec("COMMIT;");
    } catch (error) { db.exec("ROLLBACK;"); throw error; }
    try { options.social.addCredential(row.profile_id, token, "account-session", expiresAt); }
    catch (error) {
      db.prepare("UPDATE account_sessions SET revoked_at=? WHERE token_hash=?").run(now(), tokenHash);
      throw error;
    }
    const auth = options.social.authenticate(token);
    return {
      credential: { profileId: row.profile_id, token }, state: options.social.getState(auth), account: accountOf(row),
      collection: parseCollection(row.collection_json), expiresAt: new Date(expiresAt).toISOString(),
    };
  };

  const adoptInitialCredential = (row: AccountRow, token: string) => {
    const tokenHash = sha256(token);
    const createdAt = now();
    const expiresAt = createdAt + SESSION_TTL_MS;
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare("INSERT INTO account_sessions(id,profile_id,token_hash,created_at,expires_at,last_used_at) VALUES(?,?,?,?,?,?)")
        .run(`as_${randomBytes(16).toString("base64url")}`, row.profile_id, tokenHash, createdAt, expiresAt, createdAt);
      db.exec("COMMIT;");
    } catch (error) { db.exec("ROLLBACK;"); throw error; }
    const adopted = options.social.retirePrimaryCredential(row.profile_id, token, disabledCredentialHash(), "account-session", expiresAt);
    if (!adopted) {
      db.prepare("UPDATE account_sessions SET revoked_at=? WHERE token_hash=?").run(now(), tokenHash);
      throw new AccountError(500, "Could not activate the new account session.", "SESSION_ACTIVATION_FAILED");
    }
    const auth = options.social.authenticate(token);
    return {
      credential: { profileId: row.profile_id, token }, state: options.social.getState(auth), account: accountOf(row),
      collection: parseCollection(row.collection_json), expiresAt: new Date(expiresAt).toISOString(),
    };
  };

  const ensureCapacity = () => {
    if (rows().length >= 100) throw new AccountError(409, "This friend group has reached 100 players.", "ACCOUNT_LIMIT");
  };
  const addPasswordAccount = (displayName: string, password: string, tag: string | null, resetCode: unknown) => {
    const username = displayName.toLowerCase();
    const existing = rowForUsername(username);
    if (existing) {
      if (existing.password_version !== -1 || providersFor(existing.profile_id).length > 0) {
        throw new AccountError(409, "That player name already has an account. Sign in instead.", "USERNAME_TAKEN");
      }
      const code = typeof resetCode === "string" && resetCode.length <= 100 ? resetCode.trim().toUpperCase() : "";
      const salt = randomBytes(16).toString("hex");
      const timestamp = now();
      db.exec("BEGIN IMMEDIATE;");
      try {
        const claim = db.prepare("SELECT code_hash,consumed_at FROM account_reset_claims WHERE profile_id=?").get(existing.profile_id) as { code_hash: string; consumed_at: number | null } | undefined;
        if (!claim || claim.consumed_at !== null || !sameHex(sha256(code || "invalid-reset-code"), claim.code_hash)) {
          throw new AccountError(403, "Enter the one-time reset code for this account.", "ACCOUNT_CLAIM_REQUIRED");
        }
        db.prepare("DELETE FROM account_sessions WHERE profile_id=?").run(existing.profile_id);
        db.prepare("DELETE FROM account_recovery WHERE profile_id=?").run(existing.profile_id);
        db.prepare("DELETE FROM account_providers WHERE profile_id=?").run(existing.profile_id);
        db.prepare("DELETE FROM social_profile_credentials WHERE profile_id=?").run(existing.profile_id);
        db.prepare("UPDATE social_profiles SET display_name=?,token_hash=?,updated_at=? WHERE id=?")
          .run(displayName, randomBytes(32).toString("hex"), timestamp, existing.profile_id);
        const updated = db.prepare(`UPDATE club_accounts SET display_name=?,tag=?,salt=?,password_hash=?,password_version=1,
          credential_version=credential_version+1,password_enabled=1 WHERE profile_id=? AND password_version=-1`)
          .run(displayName, existing.tag, salt, scryptSync(password, salt, 32).toString("hex"), existing.profile_id);
        if (updated.changes !== 1) throw new AccountError(409, "This account is no longer waiting to be reset.", "ACCOUNT_CLAIM_USED");
        const consumed = db.prepare("UPDATE account_reset_claims SET consumed_at=? WHERE profile_id=? AND consumed_at IS NULL")
          .run(timestamp, existing.profile_id);
        if (consumed.changes !== 1) throw new AccountError(409, "That reset code was already used.", "ACCOUNT_CLAIM_USED");
        db.exec("COMMIT;");
      } catch (error) { db.exec("ROLLBACK;"); throw error; }
      const claimed = rowForProfile(existing.profile_id)!;
      return { ...issueSession(claimed), recoveryCode: createRecovery(claimed.profile_id) };
    }
    ensureCapacity();
    const salt = randomBytes(16).toString("hex");
    const profile = options.social.createProfile({ displayName });
    db.prepare(`INSERT INTO club_accounts(username,display_name,tag,salt,password_hash,profile_id,password_version,credential_version,password_enabled,created_at)
      VALUES(?,?,?,?,?,?,1,1,1,?)`).run(username, displayName, tag, salt, scryptSync(password, salt, 32).toString("hex"), profile.credential.profileId, now());
    const row = rowForUsername(username)!;
    if (tag) reconcileClub();
    return { ...adoptInitialCredential(row, profile.credential.token), recoveryCode: createRecovery(row.profile_id) };
  };

  const login = (input: unknown) => {
    const body = input as Record<string, unknown> | null;
    const username = nameOf(body?.username).toLowerCase();
    const password = typeof body?.password === "string" && body.password.length <= 128 ? body.password : "";
    const row = rowForUsername(username);
    if (row?.password_version === -1) {
      throw new AccountError(409, "This account was reset. Use Create account to choose a new password.", "ACCOUNT_RECLAIM_REQUIRED");
    }
    if (row && row.password_version < 1) throw new AccountError(409, "This legacy account requires an administrator reset.", "LEGACY_PASSWORD_MIGRATION_REQUIRED");
    const hash = scryptSync(password, row?.salt || "invalid-account-salt", 32);
    const stored = Buffer.from(row?.password_hash || "00".repeat(32), "hex");
    if (!row || stored.length !== hash.length || !timingSafeEqual(hash, stored)) throw new AccountError(401, "The player name or password is incorrect.", "INVALID_CREDENTIALS");
    if (!row.password_enabled) throw new AccountError(409, "This account uses a connected sign-in provider.", "PASSWORD_NOT_ENABLED");
    const response = issueSession(row);
    const recovery = db.prepare("SELECT 1 FROM account_recovery WHERE profile_id=?").get(row.profile_id);
    return recovery ? response : { ...response, recoveryCode: createRecovery(row.profile_id) };
  };
  const register = (input: unknown) => {
    const body = input as Record<string, unknown> | null;
    const displayName = nameOf(body?.displayName);
    return addPasswordAccount(displayName, passwordOf(body?.password, displayName), tagOf(body?.tag), body?.resetCode);
  };
  const forProfile = (profileId: string) => {
    const row = rowForProfile(profileId);
    return row ? accountOf(row) : null;
  };
  const sessionFor = (profileId: string) => {
    const row = rowForProfile(profileId);
    return row ? { account: accountOf(row), collection: parseCollection(row.collection_json) } : null;
  };
  const touchSession = (token: string) => {
    db.prepare("UPDATE account_sessions SET last_used_at=? WHERE token_hash=? AND revoked_at IS NULL").run(now(), sha256(token));
  };
  const logout = (token: string) => {
    const tokenHash = sha256(token);
    const session = db.prepare("SELECT profile_id,revoked_at FROM account_sessions WHERE token_hash=?").get(tokenHash) as { profile_id: string; revoked_at: number | null } | undefined;
    if (!session) throw new AccountError(401, "This session is not a Draft Royale account session.", "INVALID_SESSION");
    if (session.revoked_at !== null) return { alreadyRevoked: true };
    const timestamp = now();
    options.social.revokeCredential(session.profile_id, token);
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare("UPDATE account_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL").run(timestamp, tokenHash);
      db.exec("COMMIT;");
    } catch (error) { db.exec("ROLLBACK;"); throw error; }
    return { alreadyRevoked: false };
  };
  const revokeAll = (profileId: string) => {
    const timestamp = now();
    options.social.revokeCredentials(profileId, "account-session");
    db.prepare("UPDATE account_sessions SET revoked_at=? WHERE profile_id=? AND revoked_at IS NULL").run(timestamp, profileId);
  };
  const recover = (input: unknown) => {
    const body = input as Record<string, unknown> | null;
    const username = nameOf(body?.username).toLowerCase();
    const code = typeof body?.recoveryCode === "string" ? body.recoveryCode.trim().toUpperCase() : "";
    const newPassword = passwordOf(body?.newPassword);
    const row = rowForUsername(username);
    const recovery = row ? db.prepare("SELECT code_hash,used_at FROM account_recovery WHERE profile_id=?").get(row.profile_id) as { code_hash: string; used_at: number | null } | undefined : undefined;
    if (!row || !recovery || recovery.used_at !== null || !sameHex(recoveryHash(code || "invalid-recovery-code"), recovery.code_hash)) {
      throw new AccountError(401, "The player name or recovery code is incorrect.", "INVALID_RECOVERY_CODE");
    }
    const salt = randomBytes(16).toString("hex");
    revokeAll(row.profile_id);
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare("UPDATE club_accounts SET salt=?,password_hash=?,password_version=1,password_enabled=1,credential_version=credential_version+1 WHERE profile_id=?")
        .run(salt, scryptSync(newPassword, salt, 32).toString("hex"), row.profile_id);
      db.prepare("UPDATE account_recovery SET used_at=? WHERE profile_id=?").run(now(), row.profile_id);
      db.exec("COMMIT;");
    } catch (error) { db.exec("ROLLBACK;"); throw error; }
    const response = issueSession(rowForProfile(row.profile_id)!);
    return { ...response, recoveryCode: createRecovery(row.profile_id) };
  };
  const rotateRecovery = (profileId: string, input: unknown) => {
    const body = input as Record<string, unknown> | null;
    const password = typeof body?.password === "string" && body.password.length <= 128 ? body.password : "";
    const row = rowForProfile(profileId);
    if (!row || !row.password_enabled || row.password_version < 1) {
      throw new AccountError(409, "This account does not use a custom password recovery code.", "PASSWORD_NOT_ENABLED");
    }
    const hash = scryptSync(password, row.salt || "invalid-account-salt", 32);
    const stored = Buffer.from(row.password_hash || "00".repeat(32), "hex");
    if (stored.length !== hash.length || !timingSafeEqual(hash, stored)) {
      throw new AccountError(401, "The current password is incorrect.", "INVALID_CREDENTIALS");
    }
    return { recoveryCode: createRecovery(profileId) };
  };
  const clubTags = new Set((options.clubTags ?? []).flatMap((value) => {
    try { return [tagOf(value)].filter((tag): tag is string => tag !== null); } catch { return []; }
  }));
  // A reset account nobody has reclaimed yet cannot be signed in to; it only keeps a friend's tag tracked.
  const isPlaceholder = (row: AccountRow) => row.password_version === -1 && providersFor(row.profile_id).length === 0
    && !db.prepare("SELECT 1 FROM account_sessions WHERE profile_id=?").get(row.profile_id);
  const reconcileClub = () => {
    if (clubTags.size < 2) return;
    const members: string[] = [];
    for (const tag of clubTags) {
      const holders = db.prepare("SELECT * FROM club_accounts WHERE tag=? ORDER BY created_at, rowid").all(tag) as unknown as AccountRow[];
      const owner = holders.find((row) => !isPlaceholder(row));
      if (!owner) continue;
      members.push(owner.profile_id);
      // Once the real player has an account, their stand-in would only show up as a duplicate friend.
      for (const stale of holders.filter(isPlaceholder)) {
        db.prepare("DELETE FROM account_reset_claims WHERE profile_id=?").run(stale.profile_id);
        db.prepare("DELETE FROM account_recovery WHERE profile_id=?").run(stale.profile_id);
        db.prepare("DELETE FROM club_accounts WHERE profile_id=?").run(stale.profile_id);
        options.social.deleteProfile(stale.profile_id);
      }
    }
    for (const left of members) for (const right of members) if (left < right) options.social.ensureFriendship(left, right);
  };
  const updateTag = (profileId: string, value: unknown) => {
    const tag = tagOf(value);
    const changed = db.prepare("UPDATE club_accounts SET tag=? WHERE profile_id=?").run(tag, profileId);
    if (changed.changes !== 1) throw new AccountError(404, "Account not found.", "ACCOUNT_NOT_FOUND");
    reconcileClub();
    return accountOf(rowForProfile(profileId)!);
  };
  // An account is shown under the in-game name of the tag it tracks, so nobody types a name for themselves.
  const setPlayerName = (profileId: string, value: unknown) => {
    const name = typeof value === "string" ? providerNameOf(value) : "Player";
    const row = rowForProfile(profileId);
    if (!row) throw new AccountError(404, "Account not found.", "ACCOUNT_NOT_FOUND");
    if (name === "Player" || name === row.display_name) return accountOf(row);
    db.prepare("UPDATE club_accounts SET display_name=? WHERE profile_id=?").run(name, profileId);
    options.social.setDisplayName(profileId, name);
    return accountOf(rowForProfile(profileId)!);
  };
  options.social.setDisplayNameGuard((profileId) => Boolean(rowForProfile(profileId)));
  // Accounts that imported a profile before names followed the tag pick their in-game name up here.
  for (const row of rows()) {
    if (!row.tag || isPlaceholder(row)) continue;
    try {
      const profile = parseCollection(row.collection_json)?.profile;
      if (profile && profile.tag === row.tag) setPlayerName(row.profile_id, profile.name);
    } catch { /* An unreadable saved collection must not stop the server from starting. */ }
  }
  reconcileClub();
  const saveCollection = (profileId: string, input: unknown) => {
    const collection = options.normalizeCollection(input);
    const changed = db.prepare("UPDATE club_accounts SET collection_json=?,collection_updated_at=? WHERE profile_id=?")
      .run(JSON.stringify(collection), now(), profileId);
    if (changed.changes !== 1) throw new AccountError(404, "Account not found.", "ACCOUNT_NOT_FOUND");
    return collection;
  };

  const googleClientId = options.googleClientId?.trim() ?? "";
  const googleClient = googleClientId && !options.verifyGoogleIdToken ? new OAuth2Client(googleClientId) : null;
  const verifyGoogle = options.verifyGoogleIdToken ?? (async (idToken: string, audience: string) => {
    const ticket = await googleClient!.verifyIdToken({ idToken, audience });
    return ticket.getPayload() as GoogleClaims | undefined ?? {};
  });
  const createGoogleChallenge = () => {
    if (!googleClientId) throw new AccountError(503, "Google sign-in is not configured on this server.", "GOOGLE_NOT_CONFIGURED");
    const nonce = randomBytes(24).toString("base64url");
    const expiresAt = now() + GOOGLE_CHALLENGE_TTL_MS;
    const payload = Buffer.from(JSON.stringify({ nonce, expiresAt })).toString("base64url");
    const signature = createHmac("sha256", secret).update(`google-challenge:${payload}`).digest("base64url");
    const state = `${payload}.${signature}`;
    db.prepare("DELETE FROM account_google_challenges WHERE expires_at<? OR consumed_at IS NOT NULL").run(now() - GOOGLE_CHALLENGE_TTL_MS);
    db.prepare("INSERT INTO account_google_challenges(state_hash,expires_at,consumed_at) VALUES(?,?,NULL)").run(sha256(state), expiresAt);
    return { state, nonce, expiresAt: new Date(expiresAt).toISOString() };
  };
  const readGoogleChallenge = (state: unknown) => {
    if (typeof state !== "string" || state.length > 1_000) throw new AccountError(400, "Google sign-in challenge is invalid.", "INVALID_GOOGLE_CHALLENGE");
    const [payload, signature, extra] = state.split(".");
    if (!payload || !signature || extra) throw new AccountError(400, "Google sign-in challenge is invalid.", "INVALID_GOOGLE_CHALLENGE");
    const expected = createHmac("sha256", secret).update(`google-challenge:${payload}`).digest("base64url");
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new AccountError(400, "Google sign-in challenge is invalid.", "INVALID_GOOGLE_CHALLENGE");
    let challenge: { nonce?: unknown; expiresAt?: unknown };
    try { challenge = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof challenge; }
    catch { throw new AccountError(400, "Google sign-in challenge is invalid.", "INVALID_GOOGLE_CHALLENGE"); }
    if (typeof challenge.nonce !== "string" || typeof challenge.expiresAt !== "number" || challenge.expiresAt <= now()) {
      throw new AccountError(400, "Google sign-in challenge expired. Try again.", "GOOGLE_CHALLENGE_EXPIRED");
    }
    const consumed = db.prepare("UPDATE account_google_challenges SET consumed_at=? WHERE state_hash=? AND consumed_at IS NULL AND expires_at>?")
      .run(now(), sha256(state), now());
    if (consumed.changes !== 1) throw new AccountError(400, "Google sign-in challenge was already used. Try again.", "GOOGLE_CHALLENGE_USED");
    return challenge as { nonce: string; expiresAt: number };
  };
  const googleLogin = async (input: unknown, linkProfileId?: string) => {
    if (!googleClientId) throw new AccountError(503, "Google sign-in is not configured on this server.", "GOOGLE_NOT_CONFIGURED");
    const body = input as Record<string, unknown> | null;
    const idToken = typeof body?.credential === "string" && body.credential.length <= 20_000 ? body.credential : "";
    if (!idToken) throw new AccountError(400, "Google did not return a valid credential.", "INVALID_GOOGLE_TOKEN");
    const challenge = readGoogleChallenge(body?.state);
    let claims: GoogleClaims;
    try { claims = await verifyGoogle(idToken, googleClientId); }
    catch { throw new AccountError(401, "Google could not verify this sign-in.", "INVALID_GOOGLE_TOKEN"); }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!claims.sub || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss ?? "")
      || !audiences.includes(googleClientId) || typeof claims.exp !== "number" || claims.exp * 1_000 <= now()
      || claims.nonce !== challenge.nonce) {
      throw new AccountError(401, "Google could not verify this sign-in.", "INVALID_GOOGLE_TOKEN");
    }
    const existing = db.prepare("SELECT profile_id FROM account_providers WHERE provider='google' AND subject=?").get(claims.sub) as { profile_id: string } | undefined;
    if (linkProfileId) {
      if (!rowForProfile(linkProfileId)) throw new AccountError(404, "Account not found.", "ACCOUNT_NOT_FOUND");
      if (existing && existing.profile_id !== linkProfileId) throw new AccountError(409, "That Google account is already connected to another Draft Royale account.", "PROVIDER_ALREADY_LINKED");
      const other = db.prepare("SELECT subject FROM account_providers WHERE provider='google' AND profile_id=?").get(linkProfileId) as { subject: string } | undefined;
      if (other && other.subject !== claims.sub) throw new AccountError(409, "This Draft Royale account already has a different Google sign-in.", "ACCOUNT_PROVIDER_EXISTS");
      db.prepare("INSERT OR IGNORE INTO account_providers(provider,subject,profile_id,email,display_name,created_at) VALUES('google',?,?,?,?,?)")
        .run(claims.sub, linkProfileId, claims.email_verified ? claims.email ?? null : null, providerNameOf(claims.name), now());
      return issueSession(rowForProfile(linkProfileId)!);
    }
    if (existing) return issueSession(rowForProfile(existing.profile_id)!);
    ensureCapacity();
    const displayName = providerNameOf(claims.name);
    const username = `google_${sha256(claims.sub).slice(0, 20)}`;
    const profile = options.social.createProfile({ displayName });
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare(`INSERT INTO club_accounts(username,display_name,tag,salt,password_hash,profile_id,password_version,credential_version,password_enabled,created_at)
        VALUES(?,?,?,?,?,?,1,1,0,?)`).run(username, displayName, null, "", "", profile.credential.profileId, now());
      db.prepare("INSERT INTO account_providers(provider,subject,profile_id,email,display_name,created_at) VALUES('google',?,?,?,?,?)")
        .run(claims.sub, profile.credential.profileId, claims.email_verified ? claims.email ?? null : null, displayName, now());
      db.exec("COMMIT;");
    } catch (error) { db.exec("ROLLBACK;"); throw error; }
    return adoptInitialCredential(rowForProfile(profile.credential.profileId)!, profile.credential.token);
  };

  return {
    login, register, recover, rotateRecovery, logout, forProfile, sessionFor, touchSession, updateTag, setPlayerName, saveCollection,
    createGoogleChallenge, googleLogin,
    providerConfig: () => ({
      google: googleClientId ? { enabled: true, clientId: googleClientId } : { enabled: false },
      apple: { enabled: false, reason: "Apple web sign-in requires typically paid Apple Developer Program access plus an associated Apple-platform App ID and Services ID." },
    }),
    list: () => rows().map(accountOf), close: () => db.close(),
  };
}

export type AccountService = ReturnType<typeof createAccountService>;
