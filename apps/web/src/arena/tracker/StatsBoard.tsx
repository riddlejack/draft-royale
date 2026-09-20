import { useCallback, useEffect, useState, type FormEvent } from "react";
import { BarChart3, Clock3, LogIn, RefreshCw, RotateCcw, ShieldAlert, Swords, Users } from "lucide-react";
import type { SocialCredential, TrackerBattle, TrackerPairTally, TrackerPlayerTally, TrackerSummary } from "@draft-royale/shared";
import { addManualTrackerResult, fetchTrackerSummary, trackerCommandId, undoManualTrackerResult } from "./client.js";
import "./tracker.css";

export interface StatsBoardProps {
  credential: SocialCredential | null;
  onSignIn?: () => void;
}

const formatRate = (value: number | null) => value === null ? "—" : `${Math.round(value * 100)}%`;
const formatWhen = (value: string | number | null) => {
  if (value === null) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown time" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
};
const displayMode = (name: string) => name.replace(/_/g, " ");

function ResultLine({ tally }: { tally: Pick<TrackerPlayerTally, "wins" | "losses" | "draws" | "unknown"> }) {
  return <span className="tracker-record"><b>{tally.wins}W</b><b>{tally.losses}L</b>{tally.draws > 0 ? <b>{tally.draws}D</b> : null}{tally.unknown > 0 ? <em>{tally.unknown} unscored</em> : null}</span>;
}

function PlayerScore({ player }: { player: TrackerPlayerTally }) {
  return <article className="tracker-player-card">
    <div><span className="tracker-avatar">{player.displayName.slice(0, 1).toUpperCase()}</span><div><h3>{player.displayName}</h3><small>{player.tag}</small></div></div>
    <strong>{formatRate(player.winRate)}</strong>
    <ResultLine tally={player} />
    <small>{player.games} recorded {player.games === 1 ? "game" : "games"}</small>
  </article>;
}

function PairRow({ pair, relationship }: { pair: TrackerPairTally; relationship: "versus" | "together" }) {
  return <div className="tracker-pair-row">
    <div><strong>{pair.leftDisplayName}</strong><span>{relationship === "versus" ? "vs" : "+"}</span><strong>{pair.rightDisplayName}</strong></div>
    <ResultLine tally={pair} />
    <small>{relationship === "versus" ? `${pair.leftDisplayName}'s record` : "Record together"} · {pair.games} games</small>
  </div>;
}

function Team({ battle, side }: { battle: TrackerBattle; side: 0 | 1 }) {
  const participants = battle.participants.filter((participant) => participant.side === side);
  const crowns = participants.find((participant) => participant.crowns !== null)?.crowns ?? null;
  return <div className="tracker-battle-team">
    <div><strong>{participants.map((participant) => participant.name).join(" + ") || "Unknown"}</strong>{crowns === null ? null : <b>{crowns} 👑</b>}</div>
    <small>{participants.flatMap((participant) => participant.cards.map((card) => card.name)).slice(0, 8).join(" · ") || "Deck was not reported"}</small>
  </div>;
}

function RecentBattle({ battle, onUndo, undoing }: { battle: TrackerBattle; onUndo: (id: string) => void; undoing: boolean }) {
  const crownsFor = (side: 0 | 1) => battle.participants.find((participant) => participant.side === side && participant.crowns !== null)?.crowns ?? null;
  const [crownsA, crownsB] = [crownsFor(0), crownsFor(1)];
  const winnerSide = ([0, 1] as const).find((side) => battle.participants.some((participant) => participant.side === side && participant.result === "win"));
  const knownDraw = battle.participants.some((participant) => participant.result === "draw");
  const winnerNames = winnerSide === undefined ? "" : battle.participants.filter((participant) => participant.side === winnerSide).map((participant) => participant.name).join(" + ");
  const score = crownsA !== null && crownsB !== null ? `${crownsA}–${crownsB}` : winnerNames ? `${winnerNames} won` : knownDraw ? "Draw" : "Unscored";
  return <article className="tracker-battle-row">
    <header><span>{displayMode(battle.mode.name)}</span><time>{formatWhen(battle.battleTime)}</time><i className="tracker-result">{score}</i></header>
    <Team battle={battle} side={0} />
    <span className="tracker-versus">VS</span>
    <Team battle={battle} side={1} />
    <footer><span>{battle.source === "api" ? "Clash API" : "Manual tally"}</span>{battle.source === "manual" ? <button type="button" className="tracker-undo" disabled={undoing} onClick={() => onUndo(battle.id)}><RotateCcw size={13} /> Undo</button> : null}</footer>
  </article>;
}

function ManualResult({ summary, disabled, onSave }: { summary: TrackerSummary; disabled: boolean; onSave: (teamA: string, teamB: string, winner: "a" | "b" | "draw") => Promise<void> }) {
  const [teamA, setTeamA] = useState(summary.players[0]?.profileId ?? "");
  const [teamB, setTeamB] = useState(summary.players[1]?.profileId ?? "");
  const [winner, setWinner] = useState<"a" | "b" | "draw">("a");
  const valid = teamA && teamB && teamA !== teamB;
  const submit = (event: FormEvent) => { event.preventDefault(); if (valid) void onSave(teamA, teamB, winner); };
  return <form className="tracker-manual" onSubmit={submit}>
    <div className="tracker-section-heading"><div><h2>Quick tally</h2><p>Record a game when the API has not picked it up.</p></div></div>
    <div className="tracker-manual-teams">
      <label>Player A<select value={teamA} onChange={(event) => setTeamA(event.target.value)}>{summary.players.map((player) => <option key={player.profileId} value={player.profileId}>{player.displayName}</option>)}</select></label>
      <span>VS</span>
      <label>Player B<select value={teamB} onChange={(event) => setTeamB(event.target.value)}>{summary.players.map((player) => <option key={player.profileId} value={player.profileId}>{player.displayName}</option>)}</select></label>
    </div>
    <fieldset><legend>Winner</legend><label><input type="radio" name="winner" checked={winner === "a"} onChange={() => setWinner("a")} /> Player A</label><label><input type="radio" name="winner" checked={winner === "b"} onChange={() => setWinner("b")} /> Player B</label><label><input type="radio" name="winner" checked={winner === "draw"} onChange={() => setWinner("draw")} /> Draw</label></fieldset>
    <button className="royale-button gold" disabled={!valid || disabled}>{disabled ? "Saving…" : "Add result"}</button>
  </form>;
}

export function StatsBoard({ credential, onSignIn }: StatsBoardProps) {
  const [summary, setSummary] = useState<TrackerSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [insightPlayer, setInsightPlayer] = useState("all");
  const token = credential?.token ?? null;
  const profileId = credential?.profileId ?? null;
  const requestSignIn = onSignIn ?? (() => window.dispatchEvent(new CustomEvent("draft-royale:sign-in")));

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!token || !profileId) return;
    setLoading(true);
    try { setSummary(await fetchTrackerSummary({ token, profileId }, signal)); setError(null); }
    catch (cause) { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Game history could not load."); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [profileId, token]);

  useEffect(() => {
    if (!token) { setSummary(null); setLoading(false); return; }
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [refresh, token]);

  const selectedCards = (summary?.cards ?? []).filter((item) => insightPlayer === "all" || item.profileId === insightPlayer).slice(0, 8);
  const selectedDecks = (summary?.decks ?? []).filter((item) => insightPlayer === "all" || item.profileId === insightPlayer).slice(0, 6);
  const selectedModes = (summary?.modes ?? []).filter((item) => insightPlayer === "all" || item.profileId === insightPlayer).slice(0, 8);
  const selectedGames = (summary?.recentGames ?? []).filter((battle) => insightPlayer === "all" || battle.participants.some((participant) => participant.profileId === insightPlayer));
  const playerName = (profile: string) => summary?.players.find((player) => player.profileId === profile)?.displayName ?? profile;
  const saveManual = async (teamA: string, teamB: string, winner: "a" | "b" | "draw") => {
    if (!credential) return;
    setSaving(true);
    try {
      await addManualTrackerResult(credential, { commandId: trackerCommandId(), teamAProfileIds: [teamA], teamBProfileIds: [teamB], winner, battleTime: new Date().toISOString(), type: "friendly", mode: { name: "Friendly" } });
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The manual result could not be saved."); }
    finally { setSaving(false); }
  };
  const undoManual = async (battleId: string) => {
    if (!credential) return;
    setUndoing(battleId);
    try { await undoManualTrackerResult(credential, battleId, trackerCommandId()); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The manual result could not be undone."); }
    finally { setUndoing(null); }
  };

  if (!credential) return <section className="tracker-shell tracker-locked">
    <div className="tracker-lock-icon"><BarChart3 size={32} /></div><h1>Your club stats</h1><p>Sign in to see the shared game history, head-to-head tally, decks, and teammate results.</p>
    <button className="royale-button gold" onClick={requestSignIn}><LogIn size={17} /> Sign in</button>
  </section>;

  if (!summary && loading) return <section className="tracker-shell tracker-loading"><RefreshCw className="tracker-spin" size={26} /><strong>Loading game history…</strong></section>;
  if (!summary) return <section className="tracker-shell tracker-locked"><ShieldAlert size={34} /><h1>Game history is unavailable</h1><p>{error ?? "Try again in a moment."}</p><button className="royale-button" onClick={() => void refresh()}>Try again</button></section>;

  return <section className="tracker-shell">
    <header className="tracker-hero"><div><span>CLUB SCOREBOARD</span><h1>Game history</h1><p>{summary.completenessNotice}</p></div><button type="button" className="tracker-refresh" disabled={loading} onClick={() => void refresh()} aria-label="Refresh game history"><RefreshCw className={loading ? "tracker-spin" : ""} size={18} /></button></header>
    <div className={`tracker-sync ${summary.poll.configured ? summary.poll.stale ? "stale" : "live" : "setup"}`}><Clock3 size={16} /><div><strong>{summary.poll.configured ? summary.poll.stale ? "Waiting for a fresh sync" : "Automatic sync on" : "Connect automatic history"}</strong><span>{summary.poll.configured ? `${summary.poll.message} Last recorded sync: ${formatWhen(summary.poll.lastSuccessfulPollAt)}` : "Connect a Clash Royale API key to collect games automatically. Quick tally works now."}</span></div></div>
    {error ? <div className="tracker-error"><ShieldAlert size={16} /><span>{error}</span><button onClick={() => setError(null)} aria-label="Dismiss">×</button></div> : null}

    <div className="tracker-score-grid">{summary.players.map((player) => <PlayerScore key={player.profileId} player={player} />)}</div>

    <div className="tracker-layout">
      <section className="tracker-panel"><div className="tracker-section-heading"><div><h2><Swords size={19} /> Head to head</h2><p>Only games on opposite teams count here.</p></div></div>{summary.headToHead.length > 0 ? <div className="tracker-pair-list">{summary.headToHead.map((pair) => <PairRow key={`${pair.leftProfileId}:${pair.rightProfileId}`} pair={pair} relationship="versus" />)}</div> : <p className="tracker-empty">No head-to-head games recorded yet.</p>}</section>
      <section className="tracker-panel"><div className="tracker-section-heading"><div><h2><Users size={19} /> 2v2 partners</h2><p>Games played together stay separate from rivalries.</p></div></div>{summary.coPlay.length > 0 ? <div className="tracker-pair-list">{summary.coPlay.map((pair) => <PairRow key={`${pair.leftProfileId}:${pair.rightProfileId}`} pair={pair} relationship="together" />)}</div> : <p className="tracker-empty">No recorded 2v2 partnerships yet.</p>}</section>
    </div>

    <div className="tracker-insight-bar"><div><strong>Deck & card analysis</strong><span>Choose one player or compare the whole club.</span></div><label>Player<select value={insightPlayer} onChange={(event) => setInsightPlayer(event.target.value)}><option value="all">All club</option>{summary.players.map((player) => <option key={player.profileId} value={player.profileId}>{player.displayName}</option>)}</select></label></div>
    <div className="tracker-layout tracker-insights">
      <section className="tracker-panel"><div className="tracker-section-heading"><div><h2>Most played cards</h2><p>Win rate excludes unscored observations.</p></div></div>{selectedCards.length > 0 ? <div className="tracker-usage-list">{selectedCards.map((item) => <div key={`${item.profileId}:${item.card.id}:${item.card.form}`}><strong>{item.card.name}{item.card.form === "base" ? "" : ` · ${item.card.form}`}<small>{insightPlayer === "all" ? playerName(item.profileId) : ""}</small></strong><span>{item.games} games · {formatRate(item.winRate)}</span></div>)}</div> : <p className="tracker-empty">Card usage appears after the first API game.</p>}</section>
      <section className="tracker-panel"><div className="tracker-section-heading"><div><h2>Top decks</h2><p>Exact eight-card combinations from recorded games.</p></div></div>{selectedDecks.length > 0 ? <div className="tracker-deck-list">{selectedDecks.map((item) => <div key={`${item.profileId}:${item.signature}`}><div><strong>{item.cards.map((card) => card.name).join(" · ")}</strong><small>{insightPlayer === "all" ? playerName(item.profileId) : ""}</small></div><span>{item.games} games<br />{formatRate(item.winRate)} wins</span></div>)}</div> : <p className="tracker-empty">Deck records appear after the first API game.</p>}</section>
    </div>
    <div className="tracker-layout tracker-insights">
      <section className="tracker-panel"><div className="tracker-section-heading"><div><h2>Mode records</h2><p>See where each player performs best.</p></div></div>{selectedModes.length > 0 ? <div className="tracker-mode-list">{selectedModes.map((item) => <div key={`${item.profileId}:${item.modeId ?? item.modeName}`}><div><strong>{displayMode(item.modeName)}</strong><small>{insightPlayer === "all" ? playerName(item.profileId) : `${item.games} recorded games`}</small></div><div><ResultLine tally={item} /><span>{formatRate(item.winRate)}</span></div></div>)}</div> : <p className="tracker-empty">Mode records appear after the first recorded game.</p>}</section>
      <ManualResult summary={summary} disabled={saving} onSave={saveManual} />
    </div>

    <section className="tracker-recent"><div className="tracker-section-heading"><div><h2>Recent games</h2><p>{selectedGames.length} locally recorded observations{insightPlayer === "all" ? "" : ` for ${playerName(insightPlayer)}`}</p></div></div>{selectedGames.length > 0 ? <div className="tracker-battle-list">{selectedGames.map((battle) => <RecentBattle key={battle.id} battle={battle} undoing={undoing === battle.id} onUndo={undoManual} />)}</div> : <p className="tracker-empty large">No games recorded for this player yet. Automatic sync will add recent games once the API key is configured, or use Quick tally now.</p>}</section>
  </section>;
}
