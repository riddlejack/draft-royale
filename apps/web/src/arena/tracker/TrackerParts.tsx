import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { SocialCredential, TrackerCard, TrackerInsights, TrackerPlayer, TrackerRateInterval, TrackerTally } from "@draft-royale/shared";
import { ArenaCardFace } from "../components/ArenaCardFace";
import { fetchTrackerInsights, type TrackerInsightsQuery } from "./client.js";
import { decidedGames, formatDelta, formatInterval, formatRate, gamesLabel, isSmallSample } from "./insightsMath";
import { formBadge, resolveTrackerCard, trackerCardLabel, type CatalogById } from "./trackerCards";
import "./insights.css";

export const displayMode = (name: string) => name.replace(/_/g, " ");
export const formatDay = (value: string | number) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown date" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).format(date);
};
export const formatDayTime = (value: string | number) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown time" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric", hour: "numeric", minute: "2-digit" }).format(date);
};

/** Loads insights for a query and reloads when the query changes. The previous result stays visible while the next one loads. */
export function useTrackerInsights(credential: SocialCredential, query: TrackerInsightsQuery) {
  const [insights, setInsights] = useState<TrackerInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { playerTag, rivalTag, mode, dateFrom, dateTo, includeAssigned } = query;
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try { setInsights(await fetchTrackerInsights(credential, { playerTag, rivalTag, mode, dateFrom, dateTo, includeAssigned }, signal)); setError(null); }
    catch (cause) { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Insights could not load."); }
    finally { if (!signal?.aborted) setLoading(false); }
    // The credential object may be recreated by its owner; its fields are the identity.
  }, [credential.profileId, credential.token, playerTag, rivalTag, mode, dateFrom, dateTo, includeAssigned]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  return { insights, loading, error, reload: () => void load() };
}

/** "You" when the focus player is one of the viewer's own tags, otherwise that player's name. */
export const focusSubject = (players: readonly TrackerPlayer[], playerTag: string, profileId: string) => {
  const player = players.find((candidate) => candidate.tag === playerTag);
  const own = Boolean(player?.linkedProfileIds.includes(profileId));
  const name = player?.displayName ?? "This player";
  return { own, name, subject: own ? "you" : name, Subject: own ? "You" : name, possessive: own ? "your" : `${name}’s`, Possessive: own ? "Your" : `${name}’s` };
};

export function RecordLine({ tally }: { tally: Pick<TrackerTally, "wins" | "losses" | "draws" | "unknown"> }) {
  return <span className="tracker-record"><b>{tally.wins}W</b><b>{tally.losses}L</b>{tally.draws > 0 ? <b>{tally.draws}D</b> : null}{tally.unknown > 0 ? <em>{tally.unknown} unknown</em> : null}</span>;
}

/** A win rate with the games behind it. Small samples are muted and say so. */
export function RateStat({ tally, size = "md", note }: { tally: TrackerTally; size?: "sm" | "md" | "lg"; note?: string }) {
  const small = isSmallSample(tally);
  return <span className={`tracker-rate is-${size}${small ? " is-small" : ""}`}><strong>{formatRate(tally.winRate)}</strong><small>{gamesLabel(tally.games)}{small && tally.games > 0 ? " · small sample" : ""}{note ? ` · ${note}` : ""}</small></span>;
}

export function SplitBar({ tally }: { tally: Pick<TrackerTally, "wins" | "losses" | "draws"> }) {
  const decided = decidedGames(tally);
  if (!decided) return <span className="tracker-split is-empty" aria-hidden="true" />;
  return <span className="tracker-split" aria-hidden="true"><i className="win" style={{ flexGrow: tally.wins }} /><i className="draw" style={{ flexGrow: tally.draws }} /><i className="loss" style={{ flexGrow: tally.losses }} /></span>;
}

/** The 0–100% track with the Wilson interval, the observed rate and the baseline marker. Decorative: the same numbers are always printed beside it. */
export function RangeBar({ rate, interval, baseline }: { rate: number | null; interval: TrackerRateInterval | null; baseline: number | null }) {
  if (rate === null || !interval) return null;
  const pct = (value: number) => `${Math.round(Math.min(1, Math.max(0, value)) * 1000) / 10}%`;
  return <span className="tracker-range" aria-hidden="true"><i className="tracker-range-span" style={{ left: pct(interval.lower), width: pct(interval.upper - interval.lower) }} />{baseline === null ? null : <i className="tracker-range-baseline" style={{ left: pct(baseline) }} />}<i className="tracker-range-dot" style={{ left: `calc(4px + (100% - 8px) * ${Math.min(1, Math.max(0, rate)).toFixed(4)})` }} /></span>;
}

export function TrackerCardArt({ tracked, cardsById }: { tracked: TrackerCard; cardsById: CatalogById }) {
  const { card, form } = resolveTrackerCard(tracked, cardsById);
  const label = trackerCardLabel(tracked);
  if (!card) return <span className="tracker-art is-missing" title={label}>{tracked.name}</span>;
  return <span className={`tracker-art is-${form}`} role="img" aria-label={label} title={label}><ArenaCardFace card={card} form={form} />{form === "base" ? null : <span className="tracker-art-badge" aria-hidden="true">{formBadge(form)}</span>}</span>;
}

export function TrackerDeckArt({ cards, cardsById, label }: { cards: readonly TrackerCard[]; cardsById: CatalogById; label: string }) {
  return <div className="tracker-art-row" role="group" aria-label={label}>{cards.map((tracked) => <TrackerCardArt key={`${tracked.id ?? tracked.key}:${tracked.form}`} tracked={tracked} cardsById={cardsById} />)}</div>;
}

export interface TallyRow { key: string; label: ReactNode; tally: TrackerTally; detail?: string }
/** A real table so a screen reader gets "label, record, win rate, games" per row; the split bar is decoration. */
export function TallyTable({ caption, labelHeading, rows, empty, hideEmptyRows = false }: { caption: string; labelHeading: string; rows: TallyRow[]; empty: string; hideEmptyRows?: boolean }) {
  const shown = hideEmptyRows ? rows.filter((row) => row.tally.games > 0) : rows;
  if (!shown.length || shown.every((row) => row.tally.games === 0)) return <p className="tracker-empty">{empty}</p>;
  return <table className="tracker-table"><caption>{caption}</caption><thead><tr><th scope="col">{labelHeading}</th><th scope="col">Record</th><th scope="col">Win rate</th><th scope="col">Games</th></tr></thead><tbody>{shown.map((row) => {
    const small = isSmallSample(row.tally);
    return <tr key={row.key} className={row.tally.games === 0 ? "is-blank" : small ? "is-small" : ""}>
      <th scope="row"><span>{row.label}</span>{row.detail ? <small>{row.detail}</small> : null}{row.tally.games ? <small className="tracker-table-inline-record">{row.tally.wins}W {row.tally.losses}L{row.tally.draws ? ` ${row.tally.draws}D` : ""}</small> : null}<SplitBar tally={row.tally} /></th>
      <td>{row.tally.games ? <RecordLine tally={row.tally} /> : "—"}</td>
      <td className="tracker-table-rate">{row.tally.games ? formatRate(row.tally.winRate) : "—"}</td>
      <td>{row.tally.games}{small && row.tally.games > 0 ? <small>small sample</small> : null}</td>
    </tr>;
  })}</tbody></table>;
}

export function DeltaText({ delta }: { delta: number | null }) {
  if (delta === null) return null;
  return <span className={`tracker-delta ${delta < 0 ? "is-down" : delta > 0 ? "is-up" : ""}`}>{formatDelta(delta)} vs baseline</span>;
}

export const intervalText = (interval: TrackerRateInterval | null) => interval ? `likely range ${formatInterval(interval)}` : "";
