import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { BarChart3, Clock3, Database, Filter, LogIn, RefreshCw, RotateCcw, ShieldAlert, Swords, Users } from "lucide-react";
import type { SocialCredential, TrackerBattle, TrackerFilters, TrackerPlayerTally, TrackerSummary, TrackerTally } from "@draft-royale/shared";
import { addManualTrackerResult, fetchTrackerSummary, requestTrackerSync, trackerCommandId, undoManualTrackerResult } from "./client.js";
import "./tracker.css";

export interface StatsBoardProps { credential: SocialCredential | null; onSignIn?: () => void }

const formatRate = (value: number | null) => value === null ? "—" : `${Math.round(value * 100)}%`;
const formatWhen = (value: string | number | null) => {
  if (value === null) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown time" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric", hour: typeof value === "number" ? "numeric" : undefined, minute: typeof value === "number" ? "2-digit" : undefined }).format(date);
};
const displayMode = (name: string) => name.replace(/_/g, " ");
const deckNames = (cards: TrackerBattle["participants"][number]["cards"]) => cards.map((card) => card.name + (card.form === "base" ? "" : ` (${card.form})`)).join(" · ");
const sourceLabel = (battle: TrackerBattle) => battle.provenance.kind === "server_fetch" ? "Clash API" : battle.provenance.kind === "operator_snapshot" ? "Imported API snapshot" : battle.provenance.kind === "user_import" ? "User-supplied API history" : "Manual tally";

function ResultLine({ tally }: { tally: Pick<TrackerTally, "wins" | "losses" | "draws" | "unknown"> }) {
  return <span className="tracker-record"><b>{tally.wins}W</b><b>{tally.losses}L</b><b>{tally.draws}D</b>{tally.unknown > 0 ? <em>{tally.unknown} unknown</em> : null}</span>;
}

function PlayerScore({ player, focused }: { player: TrackerPlayerTally; focused: boolean }) {
  return <article className={`tracker-player-card${focused ? " focused" : ""}`}>
    <div><span className="tracker-avatar">{player.displayName.slice(0, 1).toUpperCase()}</span><div><h3>{player.displayName}</h3><small>{player.tag}</small></div></div>
    <strong>{formatRate(player.winRate)}</strong><ResultLine tally={player} /><small>{player.games} filtered {player.games === 1 ? "game" : "games"}</small>
  </article>;
}

function Team({ battle, side }: { battle: TrackerBattle; side: 0 | 1 }) {
  const participants = battle.participants.filter((participant) => participant.side === side);
  const crowns = participants.find((participant) => participant.crowns !== null)?.crowns ?? null;
  return <div className="tracker-battle-team">
    <div><strong>{participants.map((participant) => participant.name).join(" + ") || "Unknown"}</strong>{crowns === null ? null : <b>{crowns} 👑</b>}</div>
    <small>{participants.map((participant) => deckNames(participant.cards)).filter(Boolean).join(" / ") || "Deck was not reported"}</small>
  </div>;
}

function RecentBattle({ battle, focusTag, onUndo, undoing }: { battle: TrackerBattle; focusTag: string; onUndo: (id: string) => void; undoing: boolean }) {
  const focus = battle.participants.find((participant) => participant.tag === focusTag);
  const crownsFor = (side: 0 | 1) => battle.participants.find((participant) => participant.side === side && participant.crowns !== null)?.crowns ?? null;
  const [crownsA, crownsB] = [crownsFor(0), crownsFor(1)];
  const result = focus?.result ?? "unknown";
  const score = crownsA !== null && crownsB !== null ? `${crownsA}–${crownsB}` : result === "draw" ? "Draw" : result === "unknown" ? "Unscored" : result;
  return <article className="tracker-battle-row">
    <header><span>{displayMode(battle.mode.name)}{battle.unit === "duel_round" ? " · duel round" : ""}</span><time>{formatWhen(battle.battleTime)}</time><i className={`tracker-result ${result}`}>{score}</i></header>
    <Team battle={battle} side={0} /><span className="tracker-versus">VS</span><Team battle={battle} side={1} />
    <footer><span>{sourceLabel(battle)}</span>{battle.source === "manual" ? <button type="button" className="tracker-undo" disabled={undoing} onClick={() => onUndo(battle.id)}><RotateCcw size={13} /> Undo</button> : null}</footer>
  </article>;
}

function ManualResult({ summary, disabled, onSave }: { summary: TrackerSummary; disabled: boolean; onSave: (teamA: string, teamB: string, winner: "a" | "b" | "draw") => Promise<void> }) {
  const options = useMemo(() => summary.filterOptions.players.flatMap((player) => player.activeProfileIds.map((profileId) => ({ profileId, label: player.displayName, tag: player.tag }))), [summary.filterOptions.players]);
  const [teamA, setTeamA] = useState(options[0]?.profileId ?? "");
  const [teamB, setTeamB] = useState(options.find((option) => option.profileId !== teamA)?.profileId ?? "");
  const [winner, setWinner] = useState<"a" | "b" | "draw">("a");
  const valid = Boolean(teamA && teamB && teamA !== teamB);
  const submit = (event: FormEvent) => { event.preventDefault(); if (valid) void onSave(teamA, teamB, winner); };
  return <form className="tracker-manual" onSubmit={submit}>
    <div className="tracker-section-heading"><div><h2>Quick tally</h2><p>Manual observations stay separate from API history.</p></div></div>
    <div className="tracker-manual-teams">
      <label>Player A<select value={teamA} onChange={(event) => setTeamA(event.target.value)}>{options.map((option) => <option key={option.profileId} value={option.profileId}>{option.label} · {option.tag}</option>)}</select></label>
      <span>VS</span>
      <label>Player B<select value={teamB} onChange={(event) => setTeamB(event.target.value)}>{options.map((option) => <option key={option.profileId} value={option.profileId}>{option.label} · {option.tag}</option>)}</select></label>
    </div>
    <fieldset><legend>Winner</legend>{(["a", "b", "draw"] as const).map((value) => <label key={value}><input type="radio" name="winner" checked={winner === value} onChange={() => setWinner(value)} /> {value === "a" ? "Player A" : value === "b" ? "Player B" : "Draw"}</label>)}</fieldset>
    <button className="royale-button gold" disabled={!valid || disabled}>{disabled ? "Saving…" : "Add result"}</button>
  </form>;
}

function TallyList({ items, empty }: { items: Array<{ key: string; title: string; detail: string; tally: TrackerTally }>; empty: string }) {
  if (!items.length) return <p className="tracker-empty">{empty}</p>;
  return <div className="tracker-usage-list">{items.map((item) => <div key={item.key}><strong>{item.title}<small>{item.detail}</small></strong><span>{item.tally.games} · {formatRate(item.tally.winRate)}<ResultLine tally={item.tally} /></span></div>)}</div>;
}

export function StatsBoard({ credential, onSignIn }: StatsBoardProps) {
  const [summary, setSummary] = useState<TrackerSummary | null>(null);
  const [filters, setFilters] = useState<Partial<TrackerFilters>>({ relationship: "all" });
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = credential?.token ?? null;
  const requestSignIn = onSignIn ?? (() => window.dispatchEvent(new CustomEvent("draft-royale:sign-in")));

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!credential) return;
    setLoading(true);
    try { setSummary(await fetchTrackerSummary(credential, filters, signal)); setError(null); }
    catch (cause) { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Game history could not load."); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [credential, filters]);

  useEffect(() => {
    if (!token) { setSummary(null); setLoading(false); return; }
    const controller = new AbortController(); void refresh(controller.signal);
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [refresh, token]);

  const updateFilter = <K extends keyof TrackerFilters>(key: K, value: TrackerFilters[K] | "") => setFilters((current) => ({ ...current, [key]: value || null }));
  const sync = async () => {
    if (!credential || !summary?.filters.playerTag) return;
    setSyncing(true);
    try { await requestTrackerSync(credential, summary.filters.playerTag); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Sync could not be queued."); }
    finally { setSyncing(false); }
  };
  const saveManual = async (teamA: string, teamB: string, winner: "a" | "b" | "draw") => {
    if (!credential) return;
    setSaving(true);
    try { await addManualTrackerResult(credential, { commandId: trackerCommandId(), teamAProfileIds: [teamA], teamBProfileIds: [teamB], winner, battleTime: new Date().toISOString(), type: "friendly", mode: { name: "Friendly" } }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The manual result could not be saved."); }
    finally { setSaving(false); }
  };
  const undoManual = async (battleId: string) => {
    if (!credential) return;
    setUndoing(battleId);
    try { await undoManualTrackerResult(credential, battleId, trackerCommandId()); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The manual result could not be undone."); }
    finally { setUndoing(null); }
  };

  if (!credential) return <section className="tracker-shell tracker-locked"><div className="tracker-lock-icon"><BarChart3 size={32} /></div><h1>Your game history</h1><p>Sign in to track your public Clash games and compare with friends without sharing account credentials.</p><button className="royale-button gold" onClick={requestSignIn}><LogIn size={17} /> Sign in</button></section>;
  if (!summary && loading) return <section className="tracker-shell tracker-loading"><RefreshCw className="tracker-spin" size={26} /><strong>Loading game history…</strong></section>;
  if (!summary) return <section className="tracker-shell tracker-locked"><ShieldAlert size={34} /><h1>Game history is unavailable</h1><p>{error ?? "Try again in a moment."}</p><button className="royale-button" onClick={() => void refresh()}>Try again</button></section>;

  const opponents = summary.filterOptions.players.filter((player) => player.tag !== summary.filters.playerTag);
  const coverage = summary.coverage;
  const selectedPlayerIsActive = Boolean(summary.filterOptions.players.find((player) => player.tag === summary.filters.playerTag)?.activeProfileIds.length);
  return <section className="tracker-shell">
    <header className="tracker-hero"><div><span>RECORDED GAMES</span><h1>Match history</h1><p>{summary.completenessNotice}</p></div><button type="button" className="tracker-refresh" disabled={loading || syncing || !summary.poll.configured || !selectedPlayerIsActive} onClick={() => void sync()} aria-label={selectedPlayerIsActive ? "Sync selected player now" : "Historical player tag cannot be synced"} title={selectedPlayerIsActive ? undefined : "Reconnect this tag in account settings to sync it again."}><RefreshCw className={loading || syncing ? "tracker-spin" : ""} size={18} /></button></header>
    <div className={`tracker-sync ${summary.poll.configured ? summary.poll.stale ? "stale" : "live" : "setup"}`}><Clock3 size={16} /><div><strong>{summary.poll.configured ? summary.poll.stale ? "Collection needs attention" : "Automatic collection is on" : "Automatic collection is not configured"}</strong><span>{summary.poll.message} {summary.poll.lastSuccessfulPollAt ? `Last success ${formatWhen(summary.poll.lastSuccessfulPollAt)}.` : ""}</span></div></div>
    {error ? <div className="tracker-error"><ShieldAlert size={16} /><span>{error}</span><button onClick={() => setError(null)} aria-label="Dismiss">×</button></div> : null}

    <section className="tracker-filter-panel"><div className="tracker-section-heading"><div><h2><Filter size={18} /> Focus</h2><p>Performance cards and recent games use one filtered sample. Player-wide coverage stays separate.</p></div></div><div className="tracker-filter-grid tracker-primary-filters">
      <label>Player<select value={summary.filters.playerTag} onChange={(event) => updateFilter("playerTag", event.target.value)}>{summary.filterOptions.players.map((player) => <option key={player.tag} value={player.tag}>{player.displayName}</option>)}</select></label>
      <label>View<select value={summary.filters.relationship} onChange={(event) => { const relationship = event.target.value as TrackerFilters["relationship"]; setFilters((current) => ({ ...current, relationship, ...(relationship === "all" ? { opponentTag: null } : {}) })); }}><option value="all">All own games</option><option value="versus">Against player</option><option value="alongside">Alongside in 2v2</option></select></label>
      <label>Player to compare<select value={summary.filters.opponentTag ?? ""} disabled={summary.filters.relationship === "all"} onChange={(event) => updateFilter("opponentTag", event.target.value)}><option value="">Choose player</option>{opponents.map((player) => <option key={player.tag} value={player.tag}>{player.displayName}</option>)}</select></label>
    </div><details className="tracker-more-filters"><summary>Mode &amp; date</summary><div className="tracker-filter-grid tracker-secondary-filters"><label>Mode<select value={summary.filters.mode ?? ""} onChange={(event) => updateFilter("mode", event.target.value)}><option value="">All modes</option>{summary.filterOptions.modes.map((mode) => <option key={mode.key} value={mode.key}>{displayMode(mode.name)}</option>)}</select></label><label>From<input type="date" value={summary.filters.dateFrom ?? ""} onChange={(event) => updateFilter("dateFrom", event.target.value)} /></label><label>Through<input type="date" value={summary.filters.dateTo ?? ""} onChange={(event) => updateFilter("dateTo", event.target.value)} /></label></div></details></section>

    <div className="tracker-layout">
      <section className="tracker-panel tracker-sample"><div className="tracker-section-heading"><div><h2><Swords size={19} /> Filtered record</h2><p>{summary.sample.games} {summary.sample.games === 1 ? "observation" : "observations"}; duel rows count as rounds.</p></div><strong>{formatRate(summary.sample.winRate)}</strong></div><ResultLine tally={summary.sample} /></section>
      <section className="tracker-panel tracker-coverage"><div className="tracker-section-heading"><div><h2><Database size={19} /> Player-wide coverage</h2><p>All recorded observations for this player, before the focus filters. Gaps may remain.</p></div></div>{coverage ? <dl><div><dt>First observed game</dt><dd>{formatWhen(coverage.earliestBattleAt)}</dd></div><div><dt>Latest observed game</dt><dd>{formatWhen(coverage.latestBattleAt)}</dd></div><div><dt>Possible gaps</dt><dd>{coverage.possibleGaps.length}</dd></div><div><dt>All sources</dt><dd>{coverage.provenanceCounts.serverFetch} live API · {coverage.provenanceCounts.operatorSnapshot + coverage.provenanceCounts.userImport} imported · {coverage.provenanceCounts.manual} manual</dd></div></dl> : <p className="tracker-empty">Choose a tracked player.</p>}</section>
    </div>
    <div className="tracker-score-grid">{summary.players.map((player) => <PlayerScore key={player.tag} player={player} focused={player.tag === summary.filters.playerTag} />)}</div>

    <div className="tracker-layout tracker-insights">
      <section className="tracker-panel"><div className="tracker-section-heading"><div><h2>Opposing cards</h2><p>Results are from the focused player's perspective.</p></div></div><TallyList empty="No opposing-card sample for these filters." items={summary.opponentCards.slice(0, 8).map((item) => ({ key: `${item.card.id}:${item.card.form}`, title: item.card.name, detail: item.card.form === "base" ? "Base form" : item.card.form, tally: item }))} /></section>
      <section className="tracker-panel"><div className="tracker-section-heading"><div><h2>Opposing decks</h2><p>Exact decks faced in the filtered games.</p></div></div><TallyList empty="No complete opposing decks for these filters." items={summary.opponentDecks.slice(0, 6).map((item) => ({ key: item.signature, title: deckNames(item.cards), detail: "Exact opposing deck", tally: item }))} /></section>
    </div>
    <div className="tracker-layout tracker-insights">
      <section className="tracker-panel"><div className="tracker-section-heading"><div><h2>Own decks</h2><p>Each duel round is kept separate from a series result.</p></div></div><TallyList empty="No reported own decks for these filters." items={summary.decks.slice(0, 6).map((item) => ({ key: item.signature, title: deckNames(item.cards), detail: "Exact own deck", tally: item }))} /></section>
      <section className="tracker-panel"><div className="tracker-section-heading"><div><h2>Deck matchups</h2><p>Exact own deck versus exact opposing deck.</p></div></div><TallyList empty="No exact deck matchups for these filters." items={summary.deckMatchups.slice(0, 5).map((item) => ({ key: `${item.ownSignature}:${item.opponentSignature}`, title: deckNames(item.ownCards), detail: `vs ${deckNames(item.opponentCards)}`, tally: item }))} /></section>
    </div>

    <div className="tracker-layout"><ManualResult summary={summary} disabled={saving} onSave={saveManual} /><section className="tracker-panel"><div className="tracker-section-heading"><div><h2><Users size={19} /> Mode sample</h2><p>Same filters and focused player as the history.</p></div></div><TallyList empty="No modes in this sample." items={summary.modes.slice(0, 8).map((item) => ({ key: `${item.modeId}:${item.modeName}`, title: displayMode(item.modeName), detail: item.games === 1 ? "1 recorded game" : `${item.games} recorded games`, tally: item }))} /></section></div>
    <section className="tracker-recent"><div className="tracker-section-heading"><div><h2>Recent games</h2><p>{summary.recentGames.length} matching observations</p></div></div>{summary.recentGames.length ? <div className="tracker-battle-list">{summary.recentGames.map((battle) => <RecentBattle key={battle.id} battle={battle} focusTag={summary.filters.playerTag} undoing={undoing === battle.id} onUndo={undoManual} />)}</div> : <p className="tracker-empty large">No recorded games match these filters. Change the filters, sync when available, or add an explicitly manual tally.</p>}</section>
  </section>;
}
