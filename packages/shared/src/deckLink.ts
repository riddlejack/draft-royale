export const defaultTowerTroopId = 159000000;
export const clashRoyaleTowerTroopIds = [159000000, 159000001, 159000002, 159000004] as const;

export const royaleApiSmokeDeckCardIds = [26000014, 26000006, 26000010, 26000032, 26000038, 28000015, 28000017, 27000004] as const;

const battleCardIdPrefixes = new Set([26, 27, 28]);
const towerTroopIds = new Set<number>(clashRoyaleTowerTroopIds);

export const isClashRoyaleBattleCardId = (id: number) => battleCardIdPrefixes.has(Math.floor(id / 1_000_000));
export const isClashRoyaleTowerTroopId = (id: number) => towerTroopIds.has(id);

export interface ClashRoyaleDeckLinkOptions {
  towerTroopId?: number;
}

export const buildClashRoyaleDeckLink = (cardIds: readonly number[], options: ClashRoyaleDeckLinkOptions | number = {}) => {
  const towerTroopId = typeof options === "number" ? options : options.towerTroopId ?? defaultTowerTroopId;
  if (cardIds.length !== 8) throw new Error("Clash Royale deck links require exactly 8 card ids.");
  if ([...cardIds, towerTroopId].some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("Clash Royale deck links require positive integer card ids.");
  }
  if (new Set(cardIds).size !== cardIds.length) throw new Error("Clash Royale deck links require 8 unique battle card ids.");
  if (cardIds.some((id) => !isClashRoyaleBattleCardId(id))) {
    throw new Error("Clash Royale deck links must put only battle card ids in the deck payload; tower troops belong in tt.");
  }
  if (!isClashRoyaleTowerTroopId(towerTroopId)) throw new Error("Clash Royale deck links require a tower troop id in tt.");
  const copyDeckQueryKey = encodeURIComponent("clashroyale://copyDeck?deck");
  const deck = cardIds.join("%3B");
  return `https://link.clashroyale.com/en?${copyDeckQueryKey}=${deck}&l=Royals&tt=${towerTroopId}`;
};

