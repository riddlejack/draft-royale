import { useEffect, useRef, useState } from "react";
import { Flame, Handshake, RefreshCw, ShieldAlert, Swords, Users } from "lucide-react";
import type { SocialCredential, TrackerCardTally, TrackerMonthTally, TrackerRivalry, TrackerRivalryDeckTally, TrackerRivalryMeeting, TrackerStreak } from "@draft-royale/shared";
import { decidedGames, formatRate, gamesLabel, isSmallSample, rateWithSample } from "./insightsMath";
import { RateStat, RecordLine, TallyTable, TrackerCardArt, TrackerDeckArt, displayMode, focusSubject, formatDayTime, useTrackerInsights } from "./TrackerParts";
import { trackerCardLabel, type CatalogById } from "./trackerCards";

export interface RivalryBoardProps { credential: SocialCredential; cardsById: CatalogById; playerTag: string; onPlayerTagChange: (tag: string) => void }

const streakLabel = (streak: TrackerStreak) => streak.kind === "none" || streak.length === 0 ? "No streak" : `${streak.length} ${streak.kind === "win" ? (streak.length === 1 ? "win" : "wins") : streak.length === 1 ? "loss" : "losses"} in a row`;
const monthLabel = (month: string, long = false) => {
  const date = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(date.valueOf()) ? month : new Intl.DateTimeFormat(undefined, { month: long ? "long" : "short", year: long ? "numeric" : undefined, timeZone: "UTC" }).format(date);
};
/** The rival's cards that have cost the focus player the most: most losses first, then the lowest win rate. */
export const costliestRivalCards = (cards: readonly TrackerCardTally[], limit = 8) => cards.filter((card) => card.losses > 0)
  .sort((left, right) => right.losses - left.losses || (left.winRate ?? 1) - (right.winRate ?? 1) || right.games - left.games || left.card.name.localeCompare(right.card.name)).slice(0, limit);

function RivalCard({ rivalry, selected, onSelect }: { rivalry: TrackerRivalry; selected: boolean; onSelect: () => void }) {
  const { versus, alongside, currentStreak } = rivalry;
  return <button type="button" className={`rivalry-card${selected ? " is-selected" : ""}`} aria-pressed={selected} onClick={onSelect}>
    <span className="rivalry-card-name"><span className="tracker-avatar" aria-hidden="true">{rivalry.rival.displayName.slice(0, 1).toUpperCase()}</span><strong>{rivalry.rival.displayName}</strong></span>
    <span className="rivalry-card-score" aria-label={`${versus.wins} wins, ${versus.losses} losses${versus.draws ? `, ${versus.draws} draws` : ""} against`}><b>{versus.wins}</b><i>–</i><b>{versus.losses}</b></span>
    <RateStat tally={versus} size="sm" note="against" />
    <span className="rivalry-card-meta">{currentStreak.kind === "none" ? null : <em className={`is-${currentStreak.kind}`}><Flame size={11} aria-hidden="true" /> {streakLabel(currentStreak)}</em>}<span>{rivalry.sharedBattles} shared {rivalry.sharedBattles === 1 ? "battle" : "battles"}{alongside.tally.games ? ` · ${alongside.tally.games} together` : ""}</span></span>
  </button>;
}

function MonthStrip({ months, rivalName }: { months: TrackerMonthTally[]; rivalName: string }) {
  const strip = useRef<HTMLOListElement>(null);
  // A long history scrolls sideways inside the strip; start at the newest month.
  useEffect(() => { const element = strip.current; if (element) element.scrollLeft = element.scrollWidth; }, [months]);
  if (!months.length) return <p className="tracker-empty">No dated meetings yet.</p>;
  const most = Math.max(...months.map((month) => month.games), 1);
  return <ol ref={strip} className="rivalry-months" tabIndex={0} aria-label={`Results against ${rivalName} by month, oldest first`}>{months.map((month) => {
    const height = (count: number) => `${Math.max(count ? 4 : 0, count / most * 100)}%`;
    return <li key={month.month} className={isSmallSample(month) ? "is-small" : ""} aria-label={`${monthLabel(month.month, true)}: ${month.wins} wins, ${month.losses} losses${month.draws ? `, ${month.draws} draws` : ""}, ${rateWithSample(month)}`} title={`${monthLabel(month.month, true)} · ${month.wins}W ${month.losses}L${month.draws ? ` ${month.draws}D` : ""} · ${rateWithSample(month)}`}>
      <span className="rivalry-month-bars" aria-hidden="true"><i className="win" style={{ height: height(month.wins) }} /><i className="loss" style={{ height: height(month.losses) }} /></span>
      <b aria-hidden="true">{month.wins}–{month.losses}</b><small aria-hidden="true">{monthLabel(month.month)}{month.month.endsWith("-01") || month === months[0] || month === months.at(-1) ? ` ’${month.month.slice(2, 4)}` : ""}</small>
    </li>;
  })}</ol>;
}

function DeckList({ decks, cardsById, empty, labelPrefix }: { decks: TrackerRivalryDeckTally[]; cardsById: CatalogById; empty: string; labelPrefix: string }) {
  if (!decks.length) return <p className="tracker-empty">{empty}</p>;
  return <ul className="rivalry-decks">{decks.map((deck, index) => <li key={`${deck.origin}:${deck.signature}`} className={isSmallSample(deck) ? "is-small" : ""}>
    <TrackerDeckArt cards={deck.cards} cardsById={cardsById} label={`${labelPrefix} ${index + 1}: ${deck.cards.map(trackerCardLabel).join(", ")}`} />
    <div className="rivalry-deck-record"><span><RecordLine tally={deck} />{deck.origin === "assigned" ? <em className="tracker-chip">Assigned by the mode</em> : null}</span><RateStat tally={deck} size="sm" /></div>
  </li>)}</ul>;
}

function Meeting({ meeting }: { meeting: TrackerRivalryMeeting }) {
  const score = meeting.crownsFor !== null && meeting.crownsAgainst !== null ? `${meeting.crownsFor}–${meeting.crownsAgainst}` : null;
  const resultWord = meeting.result === "win" ? "Win" : meeting.result === "loss" ? "Loss" : meeting.result === "draw" ? "Draw" : "Unscored";
  return <li>
    <i className={`tracker-result ${meeting.result}`}>{resultWord}</i>
    <span className="rivalry-meeting-main"><strong>{displayMode(meeting.modeName)}</strong><small>{formatDayTime(meeting.battleTime)}{meeting.unit === "duel_round" ? " · duel round" : ""}{meeting.deckOrigin === "assigned" ? " · assigned decks" : ""}</small></span>
    <span className="rivalry-meeting-score">{score ? <><b>{score}</b><small>crowns</small></> : <small>No crowns recorded</small>}</span>
  </li>;
}

function RivalryDetail({ rivalry, focus, cardsById, includeAssigned }: { rivalry: TrackerRivalry; focus: ReturnType<typeof focusSubject>; cardsById: CatalogById; includeAssigned: boolean }) {
  const { versus, alongside } = rivalry;
  const rivalName = rivalry.rival.displayName;
  const costly = costliestRivalCards(rivalry.rivalCards);
  const deckScope = includeAssigned ? "Every eight-card deck, including mirror and draft decks." : "Only decks the players built themselves; turn on mirror/draft decks above to include the rest.";
  return <div className="rivalry-detail">
    <section className="tracker-panel rivalry-scoreline" aria-label={`${focus.Subject} against ${rivalName}`}>
      <div className="rivalry-score"><span><small>{focus.own ? "You" : focus.name}</small><b className="win">{versus.wins}</b></span><i aria-hidden="true">–</i><span><small>{rivalName}</small><b className="loss">{versus.losses}</b></span></div>
      <p className="tracker-sr">{focus.Subject} won {versus.wins} and lost {versus.losses}{versus.draws ? ` with ${versus.draws} draws` : ""} against {rivalName}.</p>
      <div className="rivalry-score-meta"><RateStat tally={versus} size="lg" note={`${focus.possessive} win rate`} />{versus.draws || versus.unknown ? <RecordLine tally={versus} /> : null}</div>
      <p className="tracker-note">Counts every recorded battle between the two, including mirror and draft friendlies. Duel rows are flagged in the meetings list.</p>
    </section>

    {versus.games === 0 ? <p className="tracker-empty large">{focus.Subject} and {rivalName} have not faced each other in a recorded battle for these filters.</p> : <>
      <dl className="rivalry-facts">
        <div><dt>Current streak</dt><dd className={`is-${rivalry.currentStreak.kind}`}>{streakLabel(rivalry.currentStreak)}</dd></div>
        <div><dt>Longest winning run</dt><dd>{rivalry.longestWinStreak}</dd></div>
        <div><dt>Longest losing run</dt><dd>{rivalry.longestLossStreak}</dd></div>
        <div><dt>Crowns for – against</dt><dd>{rivalry.crownGames ? <>{rivalry.crownsFor}–{rivalry.crownsAgainst}<small>over {gamesLabel(rivalry.crownGames)} with crowns</small></> : <small>No crowns recorded</small>}</dd></div>
        <div><dt>Three-crown wins</dt><dd>{rivalry.threeCrownWins}<small>of {versus.wins} {versus.wins === 1 ? "win" : "wins"}</small></dd></div>
        <div><dt>Three-crown losses</dt><dd>{rivalry.threeCrownLosses}<small>of {versus.losses} {versus.losses === 1 ? "loss" : "losses"}</small></dd></div>
      </dl>

      <div className="tracker-layout">
        <section className="tracker-panel"><div className="tracker-section-heading"><div><h2>Built decks vs assigned decks</h2><p>Mirror, draft and other modes hand out the deck, so those results say less about deck building.</p></div></div>
          <TallyTable caption={`${focus.Possessive} record against ${rivalName} by deck origin`} labelHeading="Decks" empty="No results yet." rows={[{ key: "chosen", label: "Decks each player built", tally: rivalry.versusChosen }, { key: "assigned", label: "Mirror, draft & assigned", tally: rivalry.versusAssigned }]} /></section>
        <section className="tracker-panel"><div className="tracker-section-heading"><div><h2>By mode</h2><p>{focus.Possessive} results against {rivalName} in each mode.</p></div></div>
          <TallyTable caption={`${focus.Possessive} record against ${rivalName} by mode`} labelHeading="Mode" empty="No modes yet." rows={rivalry.versusByMode.map((mode) => ({ key: mode.modeKey, label: displayMode(mode.modeName), tally: mode }))} /></section>
      </div>

      <section className="tracker-panel"><div className="tracker-section-heading"><div><h2>Month by month</h2><p>Green is {focus.possessive} wins, red is losses; bar height is games that month.</p></div></div><MonthStrip months={rivalry.versusByMonth} rivalName={rivalName} /></section>

      <div className="tracker-layout">
        <section className="tracker-panel"><div className="tracker-section-heading"><div><h2>{focus.Possessive} decks vs {rivalName}</h2><p>{deckScope}</p></div></div><DeckList decks={rivalry.ownDecks} cardsById={cardsById} labelPrefix={`${focus.Possessive} deck`} empty="No complete decks recorded for these meetings." /></section>
        <section className="tracker-panel"><div className="tracker-section-heading"><div><h2>{rivalName}’s decks vs {focus.subject}</h2><p>The record beside each deck is {focus.possessive} result against it.</p></div></div><DeckList decks={rivalry.rivalDecks} cardsById={cardsById} labelPrefix={`${rivalName}’s deck`} empty="No complete opposing decks recorded for these meetings." /></section>
      </div>

      <section className="tracker-panel"><div className="tracker-section-heading"><div><h2>{rivalName}’s cards that beat {focus.subject} most</h2><p>Ordered by losses, then by {focus.possessive} lowest win rate. A card is counted once per battle it appeared in; evolved and hero forms are counted apart.</p></div></div>
        {costly.length ? <ul className="rivalry-cards">{costly.map((item) => <li key={`${item.card.id ?? item.card.key}:${item.card.form}`} className={isSmallSample(item) ? "is-small" : ""}><TrackerCardArt tracked={item.card} cardsById={cardsById} /><span><strong>{trackerCardLabel(item.card)}</strong><RecordLine tally={item} /><small>{formatRate(item.winRate)} of {gamesLabel(decidedGames(item))}{isSmallSample(item) ? " · small sample" : ""}</small></span></li>)}</ul> : <p className="tracker-empty">{rivalry.rivalCards.length ? `${focus.Subject} ${focus.own ? "have" : "has"} not lost to any of ${rivalName}’s recorded decks.` : "No opposing decks recorded for these meetings."}</p>}
      </section>

      <section className="tracker-panel"><div className="tracker-section-heading"><div><h2>Recent meetings</h2><p>Newest first, from {focus.possessive} side. Up to 25 are kept.</p></div></div><ul className="rivalry-meetings">{rivalry.recentMeetings.map((meeting) => <Meeting key={meeting.battleId} meeting={meeting} />)}</ul></section>
    </>}

    <section className="tracker-panel rivalry-together"><div className="tracker-section-heading"><div><h2><Handshake size={19} aria-hidden="true" /> Playing together (2v2)</h2><p>Battles where {focus.subject} and {rivalName} were on the same side.</p></div>{alongside.tally.games ? <RateStat tally={alongside.tally} /> : null}</div>
      {alongside.tally.games === 0 ? <p className="tracker-empty">No recorded 2v2 battles together yet.</p> : <>
        <RecordLine tally={alongside.tally} />
        <TallyTable caption={`${focus.Possessive} record alongside ${rivalName} by mode`} labelHeading="Mode" empty="No modes yet." rows={alongside.byMode.map((mode) => ({ key: mode.modeKey, label: displayMode(mode.modeName), tally: mode }))} />
        <h3 className="tracker-subheading">Deck pairs</h3>
        {alongside.duoDecks.length ? <ul className="rivalry-decks rivalry-duos">{alongside.duoDecks.map((duo, index) => <li key={`${duo.ownSignature} ${duo.partnerSignature}`} className={isSmallSample(duo) ? "is-small" : ""}>
          <div className="rivalry-duo-decks"><small>{focus.own ? "You" : focus.name}</small><TrackerDeckArt cards={duo.ownCards} cardsById={cardsById} label={`Pair ${index + 1}, ${focus.possessive} deck: ${duo.ownCards.map(trackerCardLabel).join(", ")}`} /><small>{rivalName}</small><TrackerDeckArt cards={duo.partnerCards} cardsById={cardsById} label={`Pair ${index + 1}, ${rivalName}’s deck: ${duo.partnerCards.map(trackerCardLabel).join(", ")}`} /></div>
          <div className="rivalry-deck-record"><RecordLine tally={duo} /><RateStat tally={duo} size="sm" /></div>
        </li>)}</ul> : <p className="tracker-empty">{deckScope} No deck pairs match.</p>}
      </>}
    </section>
  </div>;
}

export function RivalryBoard({ credential, cardsById, playerTag, onPlayerTagChange }: RivalryBoardProps) {
  const [mode, setMode] = useState("");
  const [includeAssigned, setIncludeAssigned] = useState(false);
  const [rivalTag, setRivalTag] = useState("");
  const { insights, loading, error, reload } = useTrackerInsights(credential, { playerTag, mode, includeAssigned });

  if (!insights && loading) return <section className="tracker-shell tracker-loading"><RefreshCw className="tracker-spin" size={26} /><strong>Loading rivalries…</strong></section>;
  if (!insights) return <section className="tracker-shell tracker-locked"><ShieldAlert size={34} /><h1>Rivalries are unavailable</h1><p>{error ?? "Try again in a moment."}</p><button className="royale-button" onClick={reload}>Try again</button></section>;

  const { players } = insights.filterOptions;
  const focus = focusSubject(players, insights.filters.playerTag, credential.profileId);
  const others = players.filter((player) => player.tag !== insights.filters.playerTag);
  const selected = insights.rivalries.find((rivalry) => rivalry.rival.tag === rivalTag) ?? insights.rivalries[0] ?? null;
  const idle = others.filter((player) => !insights.rivalries.some((rivalry) => rivalry.rival.tag === player.tag));
  const filtered = Boolean(insights.filters.mode);

  return <section className="tracker-shell">
    <header className="tracker-hero"><div><span>HEAD TO HEAD</span><h1>Rivalries</h1><p>{players.length ? `${focus.Possessive} record` : "The record"} against and alongside each friend, from recorded battles only. {insights.completenessNotice}</p></div><button type="button" className="tracker-refresh" disabled={loading} onClick={reload} aria-label="Reload rivalries"><RefreshCw className={loading ? "tracker-spin" : ""} size={18} /></button></header>
    {error ? <div className="tracker-error" role="alert"><ShieldAlert size={16} /><span>{error}</span></div> : null}

    {players.length === 0 ? null : <section className="tracker-filter-panel" aria-label="Rivalry filters"><div className="tracker-filter-grid insights-filter-grid rivalry-filter-grid">
      <label>Player<select value={insights.filters.playerTag} onChange={(event) => { onPlayerTagChange(event.target.value); setRivalTag(""); setMode(""); }}>{players.map((player) => <option key={player.tag} value={player.tag}>{player.displayName}</option>)}</select></label>
      <label>Mode<select value={insights.filters.mode ?? ""} onChange={(event) => setMode(event.target.value)}><option value="">All modes</option>{insights.filterOptions.modes.map((item) => <option key={item.key} value={item.key}>{displayMode(item.name)}</option>)}</select></label>
      <label className="tracker-toggle"><input type="checkbox" checked={includeAssigned} onChange={(event) => setIncludeAssigned(event.target.checked)} /><span>Include mirror/draft decks<small>Affects the deck and card lists only. Results always count every battle.</small></span></label>
    </div></section>}

    {players.length === 0 ? <p className="tracker-empty large"><Users size={24} aria-hidden="true" /><strong>No player tag saved yet</strong>Add your Clash Royale player tag in account settings. Battles are then recorded automatically, and rivalries appear once a friend has saved a tag too.</p>
      : others.length === 0 ? <p className="tracker-empty large"><Users size={24} aria-hidden="true" />{focus.own
        ? <><strong>No friends linked yet</strong>Add a friend from the home screen. Once both of you have a player tag saved in account settings, every battle between you appears here automatically.</>
        : <><strong>Save your player tag to see rivalries</strong>Your account has no Clash Royale player tag yet, so there is nobody to set {focus.name} against. Add your tag in account settings and battles between you appear here automatically.</>}</p>
        : <>
          <div className="rivalry-grid" role="group" aria-label="Choose a rival">
            {insights.rivalries.map((rivalry) => <RivalCard key={rivalry.rival.tag} rivalry={rivalry} selected={rivalry === selected} onSelect={() => setRivalTag(rivalry.rival.tag)} />)}
            {idle.map((player) => <div key={player.tag} className="rivalry-card is-idle"><span className="rivalry-card-name"><span className="tracker-avatar" aria-hidden="true">{player.displayName.slice(0, 1).toUpperCase()}</span><strong>{player.displayName}</strong></span><small>{filtered ? "No shared battles in this mode." : "No shared battles recorded yet."}</small></div>)}
          </div>
          {selected ? <>
            <h2 className="rivalry-title"><Swords size={20} aria-hidden="true" /> {focus.own ? "You" : focus.name} vs {selected.rival.displayName}</h2>
            <RivalryDetail rivalry={selected} focus={focus} cardsById={cardsById} includeAssigned={includeAssigned} />
          </> : <p className="tracker-empty large"><Swords size={24} aria-hidden="true" /><strong>No shared battles {filtered ? "in this mode" : "yet"}</strong>{filtered ? "Choose “All modes” to see every meeting." : "Battles appear automatically once both players have a tag saved, a minute or two after they are played. Nothing needs to be entered by hand."}</p>}
        </>}
  </section>;
}
