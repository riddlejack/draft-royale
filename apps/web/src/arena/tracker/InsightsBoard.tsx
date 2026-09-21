import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Clock3, Crosshair, Droplets, Filter, Gauge, LineChart, RefreshCw, ShieldAlert, ShieldCheck, Swords, TrendingDown } from "lucide-react";
import type { SocialCredential, TrackerCard, TrackerCardInsight, TrackerInsights, TrackerTally, TrackerTrophySeries } from "@draft-royale/shared";
import { HEAT_HIGH, HEAT_LOW, SMALL_SAMPLE, decidedGames, formatRate, gamesLabel, heatColor, isSmallSample, nearestPointIndex, rateWithSample, tiltTakeaway, trophyGeometry } from "./insightsMath";
import { DeltaText, RangeBar, RateStat, RecordLine, TallyTable, TrackerCardArt, displayMode, focusSubject, formatDay, formatDayTime, intervalText, useTrackerInsights } from "./TrackerParts";
import { trackerCardLabel, type CatalogById } from "./trackerCards";

export interface InsightsBoardProps { credential: SocialCredential; cardsById: CatalogById; playerTag: string; onPlayerTagChange: (tag: string) => void }
type Focus = ReturnType<typeof focusSubject>;

const battleTypeLabels: Record<string, string> = { PvP: "Ladder (PvP)", pathOfLegend: "Path of Legend" };
const displayType = (type: string) => battleTypeLabels[type] ?? (type.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (first) => first.toUpperCase()) || "Other");
const hourLabel = (hour: number) => {
  const text = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2024, 0, 1, hour)).replace(/\s+/g, "").toLowerCase();
  return text.length <= 4 ? text : String(hour).padStart(2, "0");
};
const hourName = (hour: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2024, 0, 1, hour));
const signed = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toLocaleString()}`;

function useElementWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(200, Math.round(element.clientWidth)) || fallback);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [fallback]);
  return [ref, width] as const;
}

function TrophyChart({ series }: { series: TrackerTrophySeries }) {
  const [ref, width] = useElementWidth<HTMLDivElement>(320);
  const height = width < 480 ? 170 : 220;
  const geometry = useMemo(() => trophyGeometry(series.points, { width, height, left: 46, right: 10, top: 10, bottom: 22 }), [height, series.points, width]);
  const [active, setActive] = useState<number | null>(null);
  const { points } = geometry;
  if (!points.length || !geometry.first || !geometry.last) return null;
  const shown = points[active ?? points.length - 1] ?? points.at(-1)!;
  const pick = (event: PointerEvent<SVGSVGElement>) => { const rect = event.currentTarget.getBoundingClientRect(); if (rect.width > 0) setActive(nearestPointIndex(points, (event.clientX - rect.left) / rect.width * width)); };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = active ?? points.length - 1;
    const next = event.key === "ArrowLeft" ? current - 1 : event.key === "ArrowRight" ? current + 1 : event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); setActive(Math.min(points.length - 1, Math.max(0, next)));
  };
  const sameDay = formatDay(geometry.first.battleTime) === formatDay(geometry.last.battleTime);
  const summary = `${displayType(series.type)}: ${points.length} recorded ${points.length === 1 ? "battle" : "battles"} from ${formatDay(geometry.first.battleTime)} to ${formatDay(geometry.last.battleTime)}. Lowest ${geometry.min.toLocaleString()}, highest ${geometry.max.toLocaleString()}, latest ${geometry.last.trophies.toLocaleString()} trophies.`;
  return <figure className="trophy-chart">
    <figcaption><strong>{displayType(series.type)}</strong><small>{points.length} {points.length === 1 ? "battle" : "battles"} with trophies recorded · low {geometry.min.toLocaleString()} · high {geometry.max.toLocaleString()}</small></figcaption>
    <div ref={ref} className="trophy-chart-frame" tabIndex={0} role="group" aria-label={`${displayType(series.type)} trophy chart. Use the left and right arrow keys to read each battle.`} onKeyDown={onKey} onBlur={() => setActive(null)}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary} onPointerMove={pick} onPointerDown={pick} onPointerLeave={(event) => { if (event.pointerType === "mouse") setActive(null); }}>
        {geometry.yTicks.map((tick) => <g key={tick.value}><line className="trophy-grid" x1={46} x2={width - 10} y1={tick.y} y2={tick.y} /><text className="trophy-axis" x={40} y={tick.y + 3} textAnchor="end">{tick.value.toLocaleString()}</text></g>)}
        <text className="trophy-axis" x={points.length === 1 ? points[0]!.x : 46} y={height - 5} textAnchor={points.length === 1 ? "middle" : "start"}>{sameDay ? formatDayTime(geometry.first.battleTime) : formatDay(geometry.first.battleTime)}</text>
        {points.length > 1 ? <text className="trophy-axis" x={width - 10} y={height - 5} textAnchor="end">{sameDay ? formatDayTime(geometry.last.battleTime) : formatDay(geometry.last.battleTime)}</text> : null}
        {points.length > 1 ? <path className="trophy-line" d={geometry.path} /> : null}
        {points.length <= 60 ? points.map((point) => <circle key={point.point.battleId} className={`trophy-dot ${point.point.change < 0 ? "is-loss" : point.point.change > 0 ? "is-win" : ""}`} cx={point.x} cy={point.y} r={points.length === 1 ? 4 : 2.4} />) : null}
        {active !== null ? <><line className="trophy-cursor" x1={shown.x} x2={shown.x} y1={10} y2={height - 22} /><circle className="trophy-active" cx={shown.x} cy={shown.y} r={4.5} /></> : null}
      </svg>
    </div>
    <p className="trophy-readout" aria-live="polite"><b>{active === null ? "Latest" : `Battle ${(active ?? 0) + 1} of ${points.length}`}</b> {shown.point.trophies.toLocaleString()} trophies <span className={shown.point.change < 0 ? "is-down" : shown.point.change > 0 ? "is-up" : ""}>({signed(shown.point.change)})</span> · {displayMode(shown.point.modeName)} · {formatDayTime(shown.point.battleTime)}</p>
  </figure>;
}

function CardInsightList({ items, baseline, cardsById, focus, empty }: { items: TrackerCardInsight[]; baseline: TrackerTally; cardsById: CatalogById; focus: Focus; empty: string }) {
  if (!items.length) return <p className="tracker-empty">{empty}</p>;
  return <ul className="insight-cards">{items.map((item) => {
    const against = item.againstCard;
    return <li key={`${item.card.id ?? item.card.key}:${item.card.form}`} className={isSmallSample(against) ? "is-small" : ""}>
      <TrackerCardArt tracked={item.card} cardsById={cardsById} />
      <div className="insight-card-main"><strong>{trackerCardLabel(item.card)}</strong><span className="insight-card-line">Against it <RecordLine tally={against} /></span>{item.withCard.games > 0 ? <small>In {focus.possessive} own deck: {rateWithSample(item.withCard)}</small> : null}</div>
      <div className="insight-card-rate"><strong>{formatRate(against.winRate)}</strong><small>{gamesLabel(against.games)}{isSmallSample(against) ? " · small sample" : ""}</small></div>
      <div className="insight-card-range"><RangeBar rate={against.winRate} interval={item.againstInterval} baseline={baseline.winRate} /><small><DeltaText delta={item.againstDelta} /> · {intervalText(item.againstInterval)}</small></div>
    </li>;
  })}</ul>;
}

function AllCards({ insights, cardsById }: { insights: TrackerInsights; cardsById: CatalogById }) {
  const [all, setAll] = useState(false);
  if (!insights.cards.length) return null;
  const rows = all ? insights.cards : insights.cards.slice(0, 24);
  const cell = (tally: TrackerTally) => tally.games ? <span className={isSmallSample(tally) ? "is-small" : ""}><b>{formatRate(tally.winRate)}</b> · {tally.games}<RecordLine tally={tally} /></span> : <span className="is-small">—</span>;
  return <details className="tracker-panel insight-all-cards"><summary>Every card in this sample ({insights.cards.length})</summary>
    <table className="tracker-table"><caption>Win rate and games with each card in the deck and against each card. Evolved and hero forms are listed apart.</caption><thead><tr><th scope="col">Card</th><th scope="col">With it · games</th><th scope="col">Against it · games</th></tr></thead>
      <tbody>{rows.map((item) => <tr key={`${item.card.id ?? item.card.key}:${item.card.form}`}><th scope="row"><span className="insight-table-card"><TrackerCardArt tracked={item.card} cardsById={cardsById} /><span>{trackerCardLabel(item.card)}</span></span></th><td>{cell(item.withCard)}</td><td>{cell(item.againstCard)}</td></tr>)}</tbody></table>
    {insights.cards.length > rows.length ? <button type="button" className="tracker-more" onClick={() => setAll(true)}>Show all {insights.cards.length} cards</button> : null}
  </details>;
}

function HeatStrip({ label, cells, className }: { label: string; cells: Array<{ key: string; short: string; name: string; tally: TrackerTally }>; className: string }) {
  return <ul className={`heat-strip ${className}`} aria-label={label}>{cells.map((cell) => {
    const decided = decidedGames(cell.tally);
    const description = cell.tally.games ? `${cell.name}: ${cell.tally.wins} wins, ${cell.tally.losses} losses${cell.tally.draws ? `, ${cell.tally.draws} draws` : ""}, ${rateWithSample(cell.tally)}${decided < SMALL_SAMPLE ? ", small sample" : ""}` : `${cell.name}: no games`;
    return <li key={cell.key} className={cell.tally.games ? decided < SMALL_SAMPLE ? "is-small" : "" : "is-blank"} style={cell.tally.games ? { background: heatColor(cell.tally.winRate, decided) } : undefined} title={description} aria-label={description}>
      <small aria-hidden="true">{cell.short}</small>{cell.tally.games ? <><b aria-hidden="true">{formatRate(cell.tally.winRate)}</b><span aria-hidden="true">{cell.tally.games}</span></> : null}
    </li>;
  })}</ul>;
}

function TowerTroop({ card }: { card: TrackerCard }) {
  return <span className="insight-troop"><img src={`/assets/placeholder-card.svg(card.key)}.png`} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; }} />{card.name}</span>;
}

export function InsightsBoard({ credential, cardsById, playerTag, onPlayerTagChange }: InsightsBoardProps) {
  const [mode, setMode] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [includeAssigned, setIncludeAssigned] = useState(false);
  const { insights, loading, error, reload } = useTrackerInsights(credential, { playerTag, mode, dateFrom, dateTo, includeAssigned });

  if (!insights && loading) return <section className="tracker-shell tracker-loading"><RefreshCw className="tracker-spin" size={26} /><strong>Loading insights…</strong></section>;
  if (!insights) return <section className="tracker-shell tracker-locked"><ShieldAlert size={34} /><h1>Insights are unavailable</h1><p>{error ?? "Try again in a moment."}</p><button className="royale-button" onClick={reload}>Try again</button></section>;

  const { sample, baseline, levelGap, tilt, time, elixirLeaked, matchups } = insights;
  const focus = focusSubject(insights.filterOptions.players, insights.filters.playerTag, credential.profileId);
  const deckScope = includeAssigned ? "every eight-card deck, mirror and draft decks included" : `decks ${focus.subject} built`;
  const noBaseline = baseline.games === 0 ? `No real matches with an eight-card deck ${focus.subject} built are in this sample yet. Older rows and duels carry no single deck.` : null;
  const takeaway = tiltTakeaway(tilt, focus.subject);
  const series = insights.trophyTimeline.filter((item) => item.points.length > 0);
  const leakGames = elixirLeaked.wins.games + elixirLeaked.losses.games;
  const leaked = (value: number | null) => value === null ? "—" : value.toFixed(1);

  return <section className="tracker-shell">
    <header className="tracker-hero"><div><span>GAME PATTERNS</span><h1>Insights</h1><p>Every figure shows the games behind it. Anything under {SMALL_SAMPLE} decided games is muted as a small sample. {insights.completenessNotice}</p></div><button type="button" className="tracker-refresh" disabled={loading} onClick={reload} aria-label="Reload insights"><RefreshCw className={loading ? "tracker-spin" : ""} size={18} /></button></header>
    {error ? <div className="tracker-error" role="alert"><ShieldAlert size={16} /><span>{error}</span></div> : null}

    {insights.filterOptions.players.length === 0 ? null : <section className="tracker-filter-panel" aria-label="Insight filters"><div className="tracker-section-heading"><div><h2><Filter size={18} aria-hidden="true" /> Focus</h2></div></div><div className="tracker-filter-grid insights-filter-grid">
      <label>Player<select value={insights.filters.playerTag} onChange={(event) => { onPlayerTagChange(event.target.value); setMode(""); }}>{insights.filterOptions.players.map((player) => <option key={player.tag} value={player.tag}>{player.displayName}</option>)}</select></label>
      <label>Mode<select value={insights.filters.mode ?? ""} onChange={(event) => setMode(event.target.value)}><option value="">All modes</option>{insights.filterOptions.modes.map((item) => <option key={item.key} value={item.key}>{displayMode(item.name)}</option>)}</select></label>
      <label>From<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label>
      <label>Through<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label>
      <label className="tracker-toggle"><input type="checkbox" checked={includeAssigned} onChange={(event) => setIncludeAssigned(event.target.checked)} /><span>Include mirror/draft decks<small>Adds decks a mode assigned to the card, level, elixir and matchup sections.</small></span></label>
    </div></section>}

    {insights.filterOptions.players.length === 0 ? <p className="tracker-empty large"><strong>No player tag saved yet</strong>Add your Clash Royale player tag in account settings. Battles are recorded automatically from then on and these sections fill in as they arrive.</p> : <>
      <div className="tracker-layout">
        <section className="tracker-panel insight-sample"><div className="tracker-section-heading"><div><h2><Swords size={19} aria-hidden="true" /> All filtered battles</h2><p>Every recorded battle passing the mode and date filters. Feeds the trophy timeline, tilt, time of day and rivalries.</p></div><RateStat tally={sample} size="lg" /></div><RecordLine tally={sample} /></section>
        <section className="tracker-panel insight-sample"><div className="tracker-section-heading"><div><h2><Gauge size={19} aria-hidden="true" /> Deck-skill baseline</h2><p>Real matches (no duels) with one eight-card deck: {deckScope}. Feeds cards, level gap, elixir leaked and matchups; “vs baseline” compares with this win rate.</p></div><RateStat tally={baseline} size="lg" /></div><RecordLine tally={baseline} /></section>
      </div>

      <div className="tracker-layout">
        <section className="tracker-panel"><div className="tracker-section-heading"><div><h2><Crosshair size={19} aria-hidden="true" /> Blind spots</h2><p>Opposing cards {focus.subject} {focus.own ? "lose" : "loses"} to more than the baseline, with at least {insights.rankingMinDecided} decided games. Ordered by the top of the likely range, so long records outrank a lopsided handful.</p></div></div>
          <CardInsightList items={insights.blindSpots} baseline={baseline} cardsById={cardsById} focus={focus} empty={noBaseline ?? `No opposing card has ${insights.rankingMinDecided} decided games with a below-baseline record yet.`} /></section>
        <section className="tracker-panel"><div className="tracker-section-heading"><div><h2><ShieldCheck size={19} aria-hidden="true" /> Strengths</h2><p>Opposing cards {focus.subject} {focus.own ? "beat" : "beats"} more often than the baseline, ordered by the bottom of the likely range.</p></div></div>
          <CardInsightList items={insights.strengths} baseline={baseline} cardsById={cardsById} focus={focus} empty={noBaseline ?? `No opposing card has ${insights.rankingMinDecided} decided games with an above-baseline record yet.`} /></section>
      </div>
      <p className="tracker-note insight-legend"><span className="tracker-range" aria-hidden="true"><i className="tracker-range-span" style={{ left: "25%", width: "45%" }} /><i className="tracker-range-baseline" style={{ left: "55%" }} /><i className="tracker-range-dot" style={{ left: "45%" }} /></span><span>Bar: 0–100% win rate. Band = 95% likely range for the true rate, dot = observed rate, gold tick = baseline ({rateWithSample(baseline)}).</span></p>
      <AllCards insights={insights} cardsById={cardsById} />

      <section className="tracker-panel"><div className="tracker-section-heading"><div><h2><LineChart size={19} aria-hidden="true" /> Trophy timeline</h2><p>Trophies after each battle, one chart per battle type because their scales differ. Only battles that recorded trophies appear; up to 500 most recent.</p></div></div>
        {series.length ? <div className="trophy-charts">{series.slice(0, 4).map((item) => <TrophyChart key={item.type} series={item} />)}{series.length > 4 ? <p className="tracker-note">{series.length - 4} more battle {series.length - 4 === 1 ? "type has" : "types have"} trophy data; filter by mode to see them.</p> : null}</div> : <p className="tracker-empty">No battle in this sample recorded trophies. Rows saved before full battle detail was kept, friendlies and 2v2 carry none.</p>}
      </section>

      <section className="tracker-panel"><div className="tracker-section-heading"><div><h2><TrendingDown size={19} aria-hidden="true" /> Tilt</h2><p>A break of more than {tilt.sessionGapMinutes} minutes starts a new session. Sessions use every battle, so a mode filter still sees the losses that came before.</p></div></div>
        {tilt.sessionCount === 0 ? <p className="tracker-empty">No sessions in this sample yet.</p> : <>
          <dl className="rivalry-facts insight-facts"><div><dt>Sessions</dt><dd>{tilt.sessionCount}</dd></div><div><dt>Median session length</dt><dd>{tilt.medianSessionLength === null ? "—" : tilt.medianSessionLength}<small>battles of any mode</small></dd></div></dl>
          {takeaway ? <p className="insight-takeaway">{takeaway}</p> : <p className="tracker-note">No takeaway yet: a comparison is only written once both sides of it hold at least {SMALL_SAMPLE} decided games.</p>}
          <div className="tracker-layout insight-tables">
            <TallyTable caption="Win rate by losses in a row directly before the game, within a session" labelHeading="Before the game" empty="No games yet." rows={tilt.byPriorLosses.map((bucket) => ({ key: bucket.key, label: bucket.label, tally: bucket }))} />
            <TallyTable caption="Win rate by the game's position in its session" labelHeading="Position in session" empty="No games yet." rows={tilt.byPosition.map((bucket) => ({ key: bucket.key, label: bucket.label, tally: bucket }))} />
          </div>
        </>}
      </section>

      <section className="tracker-panel"><div className="tracker-section-heading"><div><h2><Clock3 size={19} aria-hidden="true" /> When {focus.subject} {focus.own ? "play" : "plays"}</h2><p>Shaded from red ({Math.round(HEAT_LOW * 100)}% or lower) through slate (50%) to green ({Math.round(HEAT_HIGH * 100)}% or higher), in this device’s local time. Each cell shows the win rate and, under it, the games. Faded cells have fewer than {SMALL_SAMPLE} decided games.</p></div></div>
        {sample.games === 0 ? <p className="tracker-empty">No battles in this sample.</p> : <>
          <h3 className="tracker-subheading">Hour of day</h3>
          <HeatStrip label="Win rate by hour of day" className="is-hours" cells={time.byHour.map((hour) => ({ key: String(hour.hour), short: hourLabel(hour.hour), name: hourName(hour.hour), tally: hour }))} />
          <h3 className="tracker-subheading">Day of week</h3>
          <HeatStrip label="Win rate by day of week" className="is-days" cells={time.byWeekday.map((day) => ({ key: String(day.weekday), short: day.label.slice(0, 3), name: day.label, tally: day }))} />
        </>}
      </section>

      <div className="tracker-layout">
        <section className="tracker-panel"><div className="tracker-section-heading"><div><h2>Card level gap</h2><p>1v1 battles where all sixteen card levels were recorded. The gap is how far each deck sits below its level caps, {focus.possessive} deck minus the opponent’s.</p></div></div>
          {levelGap.battles === 0 ? <p className="tracker-empty">{noBaseline ?? "No 1v1 battle in this sample recorded card levels for both decks. Rows saved before full battle detail was kept carry none."}</p> : <>
            <p className="tracker-note">{levelGap.battles} {levelGap.battles === 1 ? "battle" : "battles"}. {levelGap.meanGap === null || Math.abs(levelGap.meanGap) < 0.05 ? `On average ${focus.possessive} deck was level with the opponent’s.` : `On average ${focus.possessive} deck was ${Math.abs(levelGap.meanGap).toFixed(1)} levels per card ${levelGap.meanGap > 0 ? "behind" : "ahead of"} the opponent’s.`}</p>
            <TallyTable caption="Win rate by card level gap" labelHeading="Level gap" empty="No games yet." rows={levelGap.buckets.map((bucket) => ({ key: bucket.key, label: bucket.label, tally: bucket }))} />
          </>}
        </section>
        <section className="tracker-panel"><div className="tracker-section-heading"><div><h2><Droplets size={19} aria-hidden="true" /> Elixir leaked</h2><p>Average elixir wasted at a full bar, 1v1 only. Boosted-elixir modes are left out because they leak several times more.</p></div></div>
          {leakGames === 0 ? <p className="tracker-empty">{noBaseline ?? "No 1v1 win or loss in this sample recorded elixir leaked."}</p> : <div className={`insight-leak${leakGames < SMALL_SAMPLE ? " is-small" : ""}`}>
            <div><small>In wins</small><strong>{leaked(elixirLeaked.wins.meanLeaked)}</strong><span>{gamesLabel(elixirLeaked.wins.games)}{elixirLeaked.wins.games > 0 && elixirLeaked.wins.games < SMALL_SAMPLE ? " · small sample" : ""}</span></div>
            <div><small>In losses</small><strong>{leaked(elixirLeaked.losses.meanLeaked)}</strong><span>{gamesLabel(elixirLeaked.losses.games)}{elixirLeaked.losses.games > 0 && elixirLeaked.losses.games < SMALL_SAMPLE ? " · small sample" : ""}</span></div>
          </div>}
        </section>
      </div>

      <div className="tracker-layout">
        <section className="tracker-panel"><div className="tracker-section-heading"><div><h2>Matchups by opposing deck cost</h2><p>Opposing decks grouped by average elixir. A 2v2 can count in two rows; decks with an unknown cost are skipped.</p></div></div>
          <TallyTable caption="Win rate by the opposing deck's average elixir" labelHeading="Average elixir" empty={noBaseline ?? "No opposing decks with a known cost in this sample."} rows={matchups.byElixirBand.map((bucket) => ({ key: bucket.key, label: bucket.label, tally: bucket }))} /></section>
        <section className="tracker-panel"><div className="tracker-section-heading"><div><h2>Matchups by opposing tower troop</h2><p>Only battles that recorded the opponent’s tower troop.</p></div></div>
          <TallyTable caption="Win rate by the opposing tower troop" labelHeading="Tower troop" empty={noBaseline ?? "No battle in this sample recorded an opposing tower troop."} rows={matchups.byTowerTroop.map((troop) => ({ key: String(troop.card.id ?? troop.card.key), label: <TowerTroop card={troop.card} />, tally: troop }))} /></section>
      </div>
    </>}
  </section>;
}
