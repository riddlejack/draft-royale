import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTrackerService, parseHistoricalImport } from "./service.js";

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const fail = (message: string): never => { throw new Error(message); };
const valueAfter = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const inspectFile = (input: string, label: string, maximumBytes?: number) => {
  const resolved = path.resolve(input);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) fail(`${label} cannot be a symbolic link.`);
  if (!stat.isFile()) fail(`${label} must be a regular file.`);
  if (maximumBytes !== undefined && stat.size > maximumBytes) fail(`${label} exceeds the ${Math.round(maximumBytes / 1024 / 1024)} MB safety limit.`);
  return { resolved: fs.realpathSync(resolved), stat };
};
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;
const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const sourceInput = valueAfter("--source") ?? fail("Use --source /absolute/path/to/history.json.");
const provenanceInput = valueAfter("--provenance");
const provenance = provenanceInput === "operator_snapshot" || provenanceInput === "user_import"
  ? provenanceInput
  : fail("Use --provenance operator_snapshot or --provenance user_import.");
const source = inspectFile(sourceInput, "History source", MAX_IMPORT_BYTES);
if (path.extname(source.resolved).toLowerCase() !== ".json") fail("History source must be a .json file.");

let parsedJson: unknown;
try { parsedJson = JSON.parse(fs.readFileSync(source.resolved, "utf8")); }
catch { fail("History source is not valid JSON."); }
const label = (valueAfter("--label") ?? "Imported API observations").trim().slice(0, 160);
if (!label) fail("--label cannot be empty.");
const parsed = parseHistoricalImport(parsedJson, Date.now(), provenance, label);
const preview = {
  mode: process.argv.includes("--commit") ? "commit" : "preview",
  inputRows: parsed.inputRows,
  validUniqueRows: parsed.battles.length,
  rejectedRows: parsed.rejectedRows,
  earliestBattleAt: parsed.earliestBattleAt,
  latestBattleAt: parsed.latestBattleAt,
  provenance,
};

if (!process.argv.includes("--commit")) {
  process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
  process.exit(0);
}

const databaseInput = valueAfter("--database") ?? fail("--commit requires --database /absolute/path/to/arena.sqlite.");
const database = inspectFile(databaseInput, "Target database");
if (database.resolved === source.resolved) fail("History source and target database must be different files.");
const backupPath = path.resolve(valueAfter("--backup") ?? `${database.resolved}.backup-${timestamp()}`);
if (fs.existsSync(backupPath)) fail("Backup path already exists; choose a new --backup path.");
if (path.dirname(backupPath) === backupPath) fail("Backup path is invalid.");
fs.mkdirSync(path.dirname(backupPath), { recursive: true });

const sourceDb = new DatabaseSync(database.resolved);
try {
  const quick = sourceDb.prepare("PRAGMA quick_check").get() as { quick_check: string };
  if (quick.quick_check !== "ok") fail("Target database failed PRAGMA quick_check; no import was attempted.");
  sourceDb.exec(`VACUUM INTO ${sqlString(backupPath)}`);
} finally { sourceDb.close(); }
const backupDb = new DatabaseSync(backupPath, { readOnly: true });
try {
  const quick = backupDb.prepare("PRAGMA quick_check").get() as { quick_check: string };
  if (quick.quick_check !== "ok") fail("Backup verification failed; no import was attempted.");
} finally { backupDb.close(); }

const tracker = createTrackerService({ databasePath: database.resolved, getPlayers: () => [], autoStart: false });
try {
  const result = tracker.importHistorical(parsed, provenance);
  process.stdout.write(`${JSON.stringify({ ...preview, ...result, backupPath }, null, 2)}\n`);
} finally { tracker.close(); }
