#!/usr/bin/env node
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const databasePath = path.resolve(process.env.ARENA_DATABASE_PATH || path.join(repoRoot, "data/private/arena.sqlite"));
const username = String(process.argv[2] ?? "").trim().toLowerCase();

const usage = () => {
  console.error("Usage: pnpm migrate:legacy-account -- <player-name>");
  console.error("Set ARENA_DATABASE_PATH only when migrating a non-default private database.");
};

const readHidden = (prompt) => new Promise((resolve, reject) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    reject(new Error("Run this command in an interactive terminal so the password is not echoed."));
    return;
  }
  let value = "";
  process.stdout.write(prompt);
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const finish = (error) => {
    process.stdin.off("data", onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\n");
    if (error) reject(error); else resolve(value);
  };
  const onData = (chunk) => {
    for (const character of chunk) {
      if (character === "\u0003") { finish(new Error("Migration cancelled.")); return; }
      if (character === "\r" || character === "\n") { finish(); return; }
      if (character === "\u007f") { value = value.slice(0, -1); continue; }
      if (value.length < 128 && character >= " ") value += character;
    }
  };
  process.stdin.on("data", onData);
});

if (!username) {
  usage();
  process.exitCode = 2;
} else if (!existsSync(databasePath)) {
  console.error(`Private database not found: ${databasePath}`);
  process.exitCode = 2;
} else {
  try {
    const password = await readHidden("New password (12–128 characters): ");
    const confirmation = await readHidden("Confirm new password: ");
    if (password !== confirmation) throw new Error("Passwords do not match.");
    if (password.length < 12 || password.length > 128) throw new Error("Use a password with 12–128 characters.");
    if (password.toLocaleLowerCase() === username) throw new Error("The password cannot be the player name.");

    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;");
      const columns = new Set(database.prepare("PRAGMA table_info(club_accounts)").all().map((column) => String(column.name)));
      if (!columns.has("password_version")) database.exec("ALTER TABLE club_accounts ADD COLUMN password_version INTEGER NOT NULL DEFAULT 0;");
      const account = database.prepare("SELECT display_name FROM club_accounts WHERE username=?").get(username);
      if (!account) throw new Error("No private account has that player name.");
      if (password.toLocaleLowerCase() === String(account.display_name).toLocaleLowerCase()) throw new Error("The password cannot be the player name.");
      const salt = randomBytes(16).toString("hex");
      const hash = scryptSync(password, salt, 32).toString("hex");
      database.prepare("UPDATE club_accounts SET salt=?, password_hash=?, password_version=1 WHERE username=?").run(salt, hash, username);
      database.exec("COMMIT;");
    } catch (error) {
      try { database.exec("ROLLBACK;"); } catch { /* No active transaction. */ }
      throw error;
    } finally { database.close(); }
    console.log(`Migrated ${username}. Existing profile, friends, decks, and history were preserved.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Migration failed.");
    process.exitCode = 1;
  }
}

