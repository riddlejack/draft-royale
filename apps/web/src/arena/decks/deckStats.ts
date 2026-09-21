import { useEffect, useMemo, useRef, useState } from "react";
import type { ArenaCard, SocialCredential, TrackerCardStat, TrackerCardStats, TrackerDeckRecord, TrackerTally } from "@draft-royale/shared";
import { rememberedAccount } from "../accounts/accountClient";
import type { CardPickerStat } from "../components/CardPicker";
import { fetchTrackerCardStats, fetchTrackerDeckRecord } from "../tracker/client.js";
import { decidedGames, formatRate, gamesLabel, isSmallSample } from "../tracker/insightsMath";
import { cardStatKey } from "../tracker/trackerCards";

export const normalizePlayerTag = (value: string | null | undefined) => {
  const tag = (value ?? "").toUpperCase().replace(/\s+/g, "");
  return !tag ? "" : tag.startsWith("#") ? tag : `#${tag}`;
};

export const recordSentence = (tally: TrackerTally) => tally.games === 0 ? "no recorded games"
  : `${tally.wins}W ${tally.losses}L${tally.draws ? ` ${tally.draws}D` : ""} · ${formatRate(tally.winRate)} of ${gamesLabel(decidedGames(tally))}${isSmallSample(tally) ? " · small sample" : ""}`;

/** Card-stats entries are keyed by Clash card id, which is ArenaCard.id; the picker wants them by catalog key. */
export const statsByCardKey = (catalog: readonly ArenaCard[], cardStats: TrackerCardStats | null): ReadonlyMap<string, TrackerCardStat> => {
  const byKey = new Map<string, TrackerCardStat>();
  if (cardStats) for (const card of catalog) { const stat = cardStats.cards[cardStatKey(card)]; if (stat) byKey.set(card.key, stat); }
  return byKey;
};

export const pickerStats = (stats: ReadonlyMap<string, TrackerCardStat>): ReadonlyMap<string, CardPickerStat> => new Map([...stats].filter(([, stat]) => stat.with.games > 0 || stat.against.games > 0).map(([key, stat]) => [key, {
  games: stat.with.games, winRate: stat.with.winRate, small: isSmallSample(stat.with), badge: `${formatRate(stat.with.winRate)} · ${stat.with.games}`,
  description: `Your record with ${stat.name}: ${recordSentence(stat.with)}. Against it: ${recordSentence(stat.against)}.`,
}]));

/** The eight distinct Clash card ids of a full deck, or null while the deck is incomplete or holds a card without an id. */
export const deckCardIds = (keys: readonly string[], cardsByKey: ReadonlyMap<string, ArenaCard>): number[] | null => {
  if (keys.length !== 8) return null;
  const ids = keys.map((key) => cardsByKey.get(key)?.id);
  return ids.every((id): id is number => Number.isInteger(id) && (id as number) > 0) && new Set(ids).size === 8 ? [...ids].sort((left, right) => left - right) : null;
};

export type DeckRecordState = { status: "idle" | "loading" | "error"; record: null } | { status: "ready"; record: TrackerDeckRecord };

/**
 * The signed-in player's own card records for the deck builder. Nothing is requested unless the account has a saved tag,
 * and a response for any other tag is discarded, because the server falls back to a friend when the viewer has no tag.
 */
export function useDeckStats(credential: SocialCredential | null | undefined, catalog: readonly ArenaCard[], deckKeys: readonly string[], cardsByKey: ReadonlyMap<string, ArenaCard>) {
  const profileId = credential?.profileId ?? ""; const token = credential?.token ?? "";
  const ownTag = useMemo(() => profileId ? normalizePlayerTag(rememberedAccount()?.tag) : "", [profileId]);
  const [cardStats, setCardStats] = useState<TrackerCardStats | null>(null);
  const [deckRecord, setDeckRecord] = useState<DeckRecordState>({ status: "idle", record: null });
  const cache = useRef(new Map<string, TrackerDeckRecord>());

  useEffect(() => {
    setCardStats(null); cache.current.clear();
    if (!profileId || !token || !ownTag) return;
    const abort = new AbortController();
    fetchTrackerCardStats({ profileId, token }, ownTag, abort.signal).then((next) => { if (!abort.signal.aborted && next.playerTag === ownTag) setCardStats(next); }).catch(() => { /* The builder works without stats. */ });
    return () => abort.abort();
  }, [ownTag, profileId, token]);

  const idsKey = useMemo(() => deckCardIds(deckKeys, cardsByKey)?.join(",") ?? "", [cardsByKey, deckKeys]);
  const ready = Boolean(cardStats);
  useEffect(() => {
    if (!ready || !idsKey) { setDeckRecord({ status: "idle", record: null }); return; }
    const cached = cache.current.get(idsKey);
    if (cached) { setDeckRecord({ status: "ready", record: cached }); return; }
    setDeckRecord({ status: "loading", record: null });
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      fetchTrackerDeckRecord({ profileId, token }, idsKey.split(",").map(Number), ownTag, abort.signal)
        .then((record) => { if (abort.signal.aborted) return; if (record.playerTag !== ownTag) { setDeckRecord({ status: "idle", record: null }); return; } cache.current.set(idsKey, record); setDeckRecord({ status: "ready", record }); })
        .catch(() => { if (!abort.signal.aborted) setDeckRecord({ status: "error", record: null }); });
    }, 450);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [idsKey, ownTag, profileId, ready, token]);

  const stats = useMemo(() => statsByCardKey(catalog, cardStats), [cardStats, catalog]);
  const picker = useMemo(() => pickerStats(stats), [stats]);
  return { enabled: ready, hasCardStats: picker.size > 0, baseline: cardStats?.baseline ?? null, stats, picker, deckRecord };
}
