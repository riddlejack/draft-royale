import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SocialService } from "../social/service.js";

export class AccountError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export interface ClubAccount { username: string; displayName: string; tag: string; profileId: string }
type AccountRow = { username: string; display_name: string; tag: string; salt: string; password_hash: string; profile_id: string; password_version: number; credential_version: number };
const accountOf = (row: AccountRow): ClubAccount => ({ username: row.username, displayName: row.display_name, tag: row.tag, profileId: row.profile_id });
const nameOf = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_ .-]{2,32}$/.test(value.trim())) throw new AccountError(400, "Use a player name with 2–32 letters, numbers, spaces, or underscores.");
  return value.trim();
};
const tagOf = (value: unknown) => {
  if (typeof value !== "string") throw new AccountError(400, "Enter your Clash Royale player tag.");
  const tag = `#${value.replace(/^#/, "").trim().toUpperCase()}`;
  if (!/^#[0289PYLQGRJCUV]{3,15}$/.test(tag)) throw new AccountError(400, "Enter a valid Clash Royale tag, such as #P0LYQ.");
  return tag;
};
const passwordOf = (value: unknown, displayName?: string) => {
  if (typeof value !== "string" || value.length < 12 || value.length > 128) throw new AccountError(400, "Use a password with 12–128 characters.");
  if (displayName && value.toLocaleLowerCase() === displayName.toLocaleLowerCase()) throw new AccountError(400, "Your password cannot be your player name.");
  return value;
};

export function createAccountService(options: { databasePath: string; social: SocialService }) {
  const db = new DatabaseSync(options.databasePath);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
  db.exec(`CREATE TABLE IF NOT EXISTS club_account_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS club_accounts (username TEXT PRIMARY KEY, display_name TEXT NOT NULL, tag TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, profile_id TEXT NOT NULL UNIQUE, password_version INTEGER NOT NULL DEFAULT 1, credential_version INTEGER NOT NULL DEFAULT 1);`);
  const accountColumns = new Set((db.prepare("PRAGMA table_info(club_accounts)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!accountColumns.has("password_version")) db.exec("ALTER TABLE club_accounts ADD COLUMN password_version INTEGER NOT NULL DEFAULT 0;");
  if (!accountColumns.has("credential_version")) db.exec("ALTER TABLE club_accounts ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0;");
  db.prepare("INSERT OR IGNORE INTO club_account_meta VALUES('identity_secret',?)").run(randomBytes(32).toString("hex"));
  const secret = String(db.prepare("SELECT value FROM club_account_meta WHERE key='identity_secret'").get()?.value);
  const credentialFor = (username: string, version: number) => createHmac("sha256", secret)
    .update(version < 1 ? `club-profile:${username}` : `club-profile:${username}:v${version}`)
    .digest("base64url");
  const rows = () => db.prepare("SELECT * FROM club_accounts ORDER BY rowid").all() as unknown as AccountRow[];
  for (const row of rows().filter((candidate) => candidate.password_version < 1)) {
    const disabledHash = createHash("sha256").update(createHmac("sha256", secret).update(`club-profile-disabled:${row.username}:${row.profile_id}`).digest("base64url")).digest("hex");
    db.prepare("UPDATE social_profiles SET token_hash=? WHERE id=? AND token_hash<>?").run(disabledHash, row.profile_id, disabledHash);
  }
  const add = (displayName: string, tag: string, password: string) => {
    if (rows().length >= 100) throw new AccountError(409, "This friend group has reached 100 players.");
    const username = displayName.toLowerCase();
    if (db.prepare("SELECT 1 FROM club_accounts WHERE username=? OR tag=?").get(username, tag)) throw new AccountError(409, "That name or player tag already has an account. Sign in instead.");
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 32).toString("hex");
    const profile = options.social.createProfile({ displayName, credentialToken: credentialFor(username, 1) });
    db.prepare("INSERT INTO club_accounts(username,display_name,tag,salt,password_hash,profile_id,password_version,credential_version) VALUES(?,?,?,?,?,?,1,1)").run(username, displayName, tag, salt, hash, profile.credential.profileId);
    return accountOf(db.prepare("SELECT * FROM club_accounts WHERE username=?").get(username) as unknown as AccountRow);
  };
  const login = (input: unknown) => {
    const body = input as Record<string, unknown> | null;
    const username = nameOf(body?.username).toLowerCase();
    const password = typeof body?.password === "string" && body.password.length <= 128 ? body.password : "";
    const row = db.prepare("SELECT * FROM club_accounts WHERE username=?").get(username) as unknown as AccountRow | undefined;
    const hash = scryptSync(password, row?.salt ?? "invalid-account-salt", 32);
    if (!row || !timingSafeEqual(hash, Buffer.from(row.password_hash, "hex"))) throw new AccountError(401, "The player name or password is incorrect.");
    if (row.password_version < 1) throw new AccountError(409, "This private legacy account needs a one-time password migration before it can sign in.");
    const session = options.social.createProfile({ displayName: row.display_name, credentialToken: credentialFor(username, row.credential_version) });
    return { ...session, account: accountOf(row) };
  };
  const register = (input: unknown) => {
    const body = input as Record<string, unknown> | null;
    const displayName = nameOf(body?.displayName);
    const tag = tagOf(body?.tag);
    const password = passwordOf(body?.password, displayName);
    add(displayName, tag, password);
    return login({ username: displayName, password });
  };
  const forProfile = (profileId: string) => {
    const row = db.prepare("SELECT * FROM club_accounts WHERE profile_id=?").get(profileId) as unknown as AccountRow | undefined;
    return row ? accountOf(row) : null;
  };
  return { login, register, forProfile, list: () => rows().map(accountOf), close: () => db.close() };
}
export type AccountService = ReturnType<typeof createAccountService>;
