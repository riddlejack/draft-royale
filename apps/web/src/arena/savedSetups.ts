import { ARENA_MEGA_MAX_POOL_SIZE, isChaosInfiniteElixirBattleMode, isArenaElixirRanges, type ArenaSettings } from "@draft-royale/shared";

export const SAVED_SETUPS_VERSION = 1;
export const SAVED_SETUPS_LIMIT = 12;
export const SAVED_SETUPS_KEY = "draft-royale:arena-saved-setups";

export interface SavedBattleSetup {
  id: string;
  name: string;
  settings: ArenaSettings;
  updatedAt: number;
}

interface SetupStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SavedSetupResult {
  setups: SavedBattleSetup[];
  error?: string;
}

const modes = new Set(["mega", "triple", "classic"]);
const timerModes = new Set(["per_pick", "whole_draft"]);
const storageError = "Saved battles are unavailable in this browser.";
const recordOf = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : null;

const stringList = (value: unknown, limit: number): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > limit) return undefined;
  const entries = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0 && item.length <= 100);
  if (entries.length !== value.length) return undefined;
  return Array.from(new Set(entries.map((item) => item.trim())));
};
const cardIdList = (value: unknown, limit: number): number[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > limit || value.some((item) => !Number.isSafeInteger(item) || item <= 0)) return undefined;
  return Array.from(new Set(value as number[]));
};
const optionalNumber = (value: unknown) => value === undefined
  ? undefined
  : typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10
    ? value
    : null;

export function sanitizeSavedSettings(value: unknown): ArenaSettings | null {
  const input = recordOf(value);
  if (!input || !modes.has(String(input.mode)) || !timerModes.has(String(input.timerMode))) return null;
  if (!Number.isInteger(input.poolSize) || (input.poolSize as number) < 16 || (input.poolSize as number) > 96) return null;
  if (!Number.isInteger(input.pickSeconds) || (input.pickSeconds as number) < 1 || (input.pickSeconds as number) > 120) return null;
  if (typeof input.specialForms !== "boolean" || typeof input.battleMode !== "string" || !input.battleMode.trim() || input.battleMode.length > 80) return null;
  if (input.groupedSpecialRounds !== undefined && typeof input.groupedSpecialRounds !== "boolean") return null;
  if (input.mirrorMode !== undefined && typeof input.mirrorMode !== "boolean") return null;
  const minElixir = optionalNumber(input.minElixir);
  const maxElixir = optionalNumber(input.maxElixir);
  if (input.elixirRanges !== undefined && !isArenaElixirRanges(input.elixirRanges)) return null;
  if (minElixir === null || maxElixir === null || (minElixir !== undefined && maxElixir !== undefined && minElixir > maxElixir)) return null;
  const cardKinds = stringList(input.cardKinds, 32);
  const rarities = stringList(input.rarities, 32);
  const families = stringList(input.families, 64);
  const includeCards = stringList(input.includeCards, 256);
  const excludeCards = stringList(input.excludeCards, 256);
  const includedCardIds = cardIdList(input.includedCardIds, 256);
  const excludedCardIds = cardIdList(input.excludedCardIds, 256);
  if ((input.cardKinds !== undefined && cardKinds === undefined)
    || (input.rarities !== undefined && rarities === undefined)
    || (input.families !== undefined && families === undefined)
    || (input.includeCards !== undefined && includeCards === undefined)
    || (input.excludeCards !== undefined && excludeCards === undefined)
    || (input.includedCardIds !== undefined && includedCardIds === undefined)
    || (input.excludedCardIds !== undefined && excludedCardIds === undefined)) return null;
  const battleMode = input.battleMode.trim();
  const infiniteElixir = isChaosInfiniteElixirBattleMode(battleMode);
  return {
    mode: input.mode as ArenaSettings["mode"],
    poolSize: Math.min(input.poolSize as number, ARENA_MEGA_MAX_POOL_SIZE),
    pickSeconds: input.pickSeconds as number,
    timerMode: input.timerMode as ArenaSettings["timerMode"],
    specialForms: infiniteElixir ? false : input.specialForms,
    ...(infiniteElixir ? { groupedSpecialRounds: false } : input.groupedSpecialRounds === undefined ? {} : { groupedSpecialRounds: input.groupedSpecialRounds }),
    mirrorMode: input.mirrorMode ?? false,
    battleMode,
    ...(minElixir === undefined ? {} : { minElixir }),
    ...(maxElixir === undefined ? {} : { maxElixir }),
    ...(input.elixirRanges === undefined ? {} : { elixirRanges: input.elixirRanges.map(({ min, max }) => ({ min, max })) }),
    ...(cardKinds === undefined ? {} : { cardKinds }),
    ...(rarities === undefined ? {} : { rarities }),
    ...(families === undefined ? {} : { families }),
    ...(includeCards === undefined ? {} : { includeCards }),
    ...(excludeCards === undefined ? {} : { excludeCards }),
    ...(includedCardIds === undefined ? {} : { includedCardIds }),
    ...(excludedCardIds === undefined ? {} : { excludedCardIds }),
  };
}

const sanitizeSetup = (value: unknown): SavedBattleSetup | null => {
  const input = recordOf(value);
  if (!input || typeof input.id !== "string" || !input.id.trim() || input.id.length > 100) return null;
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 40) return null;
  if (typeof input.updatedAt !== "number" || !Number.isFinite(input.updatedAt)) return null;
  const settings = sanitizeSavedSettings(input.settings);
  return settings ? { id: input.id, name: input.name.trim(), settings, updatedAt: input.updatedAt } : null;
};

const browserStorage = (): SetupStorage => window.localStorage;

export function readSavedSetups(storage?: SetupStorage): SavedSetupResult {
  try {
    const raw = (storage ?? browserStorage()).getItem(SAVED_SETUPS_KEY);
    if (!raw) return { setups: [] };
    const envelope = recordOf(JSON.parse(raw) as unknown);
    if (!envelope || envelope.version !== SAVED_SETUPS_VERSION || !Array.isArray(envelope.setups)) return { setups: [], error: "Saved battle data could not be read." };
    const seen = new Set<string>();
    const setups: SavedBattleSetup[] = [];
    let skipped = false;
    for (const candidate of envelope.setups) {
      const setup = sanitizeSetup(candidate);
      if (!setup || seen.has(setup.id)) { skipped = true; continue; }
      seen.add(setup.id);
      if (setups.length < SAVED_SETUPS_LIMIT) setups.push(setup);
      else skipped = true;
    }
    return { setups, ...(skipped ? { error: "Some saved battles could not be read." } : {}) };
  } catch {
    return { setups: [], error: storageError };
  }
}

const writeSetups = (setups: readonly SavedBattleSetup[], storage?: SetupStorage): string | undefined => {
  try {
    (storage ?? browserStorage()).setItem(SAVED_SETUPS_KEY, JSON.stringify({ version: SAVED_SETUPS_VERSION, setups }));
    return undefined;
  } catch {
    return storageError;
  }
};
const setupId = () => typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function saveSetupCopy(current: readonly SavedBattleSetup[], name: string, settingsValue: ArenaSettings, storage?: SetupStorage): SavedSetupResult & { saved?: SavedBattleSetup } {
  const cleanName = name.trim();
  const settings = sanitizeSavedSettings(settingsValue);
  if (!cleanName || cleanName.length > 40) return { setups: [...current], error: "Enter a name up to 40 characters." };
  if (!settings) return { setups: [...current], error: "These rules cannot be saved yet." };
  if (current.length >= SAVED_SETUPS_LIMIT) return { setups: [...current], error: "Delete a saved battle before adding another." };
  const saved = { id: setupId(), name: cleanName, settings, updatedAt: Date.now() };
  const setups = [saved, ...current];
  const error = writeSetups(setups, storage);
  return error ? { setups: [...current], error } : { setups, saved };
}

export function deleteSavedSetup(current: readonly SavedBattleSetup[], id: string, storage?: SetupStorage): SavedSetupResult {
  const setups = current.filter((setup) => setup.id !== id);
  const error = writeSetups(setups, storage);
  return error ? { setups: [...current], error } : { setups };
}
