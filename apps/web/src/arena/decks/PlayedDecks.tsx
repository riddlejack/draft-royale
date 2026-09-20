import { useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, History, Pencil, Save } from "lucide-react";
import type { ArenaCard, ArenaForm, DeckDefinition, SocialCredential, TrackerCard, TrackerDeckLog, TrackerDeckLogEntry } from "@draft-royale/shared";
import { validateDeck } from "@draft-royale/shared";
import { ArenaCardFace } from "../components/ArenaCardFace";
import { fetchTrackerDeckLog } from "../tracker/client.js";
import { clashDeckLink, createDeckId } from "./deckUtils";

type OriginFilter = "chosen" | "assigned" | "all";
type SortKey = "recent" | "played" | "winRate";

const formatRate = (value: number | null) => value === null ? "—" : `${Math.round(value * 100)}%`;
const formatDay = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "unknown" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).format(date);
};
const displayMode = (name: string) => name.replace(/_/g, " ");
const modeKeyOf = (mode: { type: string; modeId: number | null; modeName: string }) => `${mode.type}:${mode.modeId ?? mode.modeName}`;

// The catalog has no combined hero-evolution form; the evolution art is the closer match when it exists.
const catalogForm = (card: ArenaCard, tracked: TrackerCard): ArenaForm => {
  const wanted: ArenaForm[] = tracked.form === "heroEvolution" ? ["evolution", "hero"] : tracked.form === "base" ? [] : [tracked.form];
  return wanted.find((form) => card.forms.some((candidate) => candidate.key === form)) ?? "base";
};

const toDeckDefinition = (entry: TrackerDeckLogEntry, cardsById: ReadonlyMap<number, ArenaCard>, ownerLabel: string): DeckDefinition | null => {
  const forms: DeckDefinition["forms"] = {};
  const keys: string[] = [];
  for (const tracked of entry.cards) {
    const card = tracked.id === null ? undefined : cardsById.get(tracked.id);
    if (!card) return null;
    keys.push(card.key);
    const form = catalogForm(card, tracked);
    if (form !== "base") forms[card.key] = form;
  }
  const lead = [...entry.cards].sort((left, right) => (right.elixirCost ?? 0) - (left.elixirCost ?? 0)).slice(0, 2).map((card) => card.name).join(" · ");
  return { id: createDeckId(), name: `${lead} deck`.slice(0, 80), mode: "custom", cards: keys, forms, source: { kind: "local", label: `Played by ${ownerLabel}` }, description: `${entry.games} recorded ${entry.games === 1 ? "game" : "games"} · ${formatRate(entry.winRate)} win rate` };
};

function PlayedDeckRow({ entry, deck, catalog, cardsById, cardsByKey, onEdit, onSave, onCopy, saving, saved }: { entry: TrackerDeckLogEntry; deck: DeckDefinition | null; catalog: readonly ArenaCard[]; cardsById: ReadonlyMap<number, ArenaCard>; cardsByKey: ReadonlyMap<string, ArenaCard>; onEdit: (deck: DeckDefinition) => void; onSave?: (deck: DeckDefinition) => void; onCopy: (value: string, message: string) => void; saving: boolean; saved: boolean }) {
  const link = deck && validateDeck(deck, catalog).valid ? clashDeckLink(deck, cardsByKey) : "";
  return <article className="library-deck-row played-deck-row">
    <div className="played-deck-record"><strong>{formatRate(entry.winRate)}</strong><span><b>{entry.wins}W</b><b>{entry.losses}L</b>{entry.draws > 0 ? <b>{entry.draws}D</b> : null}</span><small>{entry.games} {entry.games === 1 ? "game" : "games"}</small></div>
    <div className="library-card-row" aria-label="Deck cards">{entry.cards.map((tracked) => {
      const card = tracked.id === null ? undefined : cardsById.get(tracked.id);
      if (!card) return <span className="library-card-missing" key={`${tracked.id}:${tracked.key}`}>{tracked.name}</span>;
      const form = catalogForm(card, tracked);
      return <span className={`library-card is-${form}`} key={card.key} title={tracked.name}><ArenaCardFace card={card} form={form} /><span className="library-form-badge">{form === "evolution" ? "E" : form === "hero" ? "H" : form === "champion" ? "C" : ""}</span></span>;
    })}</div>
    <footer className="library-deck-footer">
      <span className="library-elixir"><i aria-hidden="true" /> {entry.averageElixir === null ? "—" : entry.averageElixir.toFixed(1)}</span>
      <span className="played-deck-meta">{entry.origin === "assigned" ? <em>Assigned by the mode{entry.originInferred ? " (inferred)" : ""}</em> : null}{entry.modes.slice(0, 3).map((mode) => `${displayMode(mode.modeName)} ${mode.wins}–${mode.losses}`).join(" · ")}{entry.modes.length > 3 ? ` · +${entry.modes.length - 3} more` : ""} · {entry.firstUsedAt.slice(0, 10) === entry.lastUsedAt.slice(0, 10) ? formatDay(entry.lastUsedAt) : `${formatDay(entry.firstUsedAt)} – ${formatDay(entry.lastUsedAt)}`}{entry.towerTroop ? ` · ${entry.towerTroop.name}` : ""}</span>
      <div className="library-deck-actions">
        {deck && <button type="button" onClick={() => onEdit(deck)}><Pencil size={14} /> Open in builder</button>}
        {deck && onSave && <button type="button" disabled={saving || saved} onClick={() => onSave(deck)}>{saved ? <><Check size={14} /> Saved</> : <><Save size={14} /> Save</>}</button>}
        {link && <button type="button" onClick={() => onCopy(link, "Clash deck link copied.")}><Copy size={14} /> Copy</button>}
        {link && <a href={link} target="_blank" rel="noreferrer">Open <ExternalLink size={13} /></a>}
      </div>
    </footer>
  </article>;
}

export function PlayedDecks({ credential, catalog, scope, onEdit, onSave, onCopy }: { credential: SocialCredential; catalog: readonly ArenaCard[]; scope: "self" | "friends"; onEdit: (deck: DeckDefinition) => void; onSave?: (deck: DeckDefinition) => Promise<unknown>; onCopy: (value: string, message: string) => void }) {
  const [log, setLog] = useState<TrackerDeckLog | null>(null);
  const [error, setError] = useState("");
  const [friendTag, setFriendTag] = useState("");
  const [origin, setOrigin] = useState<OriginFilter>("chosen");
  const [mode, setMode] = useState("");
  const [minimumGames, setMinimumGames] = useState(1);
  const [sort, setSort] = useState<SortKey>("recent");
  const [limit, setLimit] = useState(12);
  const [savingSignature, setSavingSignature] = useState("");
  const [savedSignatures, setSavedSignatures] = useState<ReadonlySet<string>>(new Set());
  const cardsById = useMemo(() => new Map(catalog.map((card) => [card.id, card])), [catalog]);
  const cardsByKey = useMemo(() => new Map(catalog.map((card) => [card.key, card])), [catalog]);

  useEffect(() => {
    const abort = new AbortController();
    fetchTrackerDeckLog(credential, scope === "friends" ? friendTag : "", abort.signal)
      .then((next) => { setLog(next); setError(""); })
      .catch((failure: unknown) => { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : "Played decks could not load."); });
    return () => abort.abort();
  }, [credential.profileId, credential.token, friendTag, scope]);

  const isOwn = (tag: string) => Boolean(log?.players.find((player) => player.tag === tag)?.linkedProfileIds.includes(credential.profileId));
  const friends = useMemo(() => (log?.players ?? []).filter((player) => !player.linkedProfileIds.includes(credential.profileId)), [credential.profileId, log]);
  useEffect(() => { if (scope === "friends" && !friendTag && friends[0]) setFriendTag(friends[0].tag); }, [friendTag, friends, scope]);

  const subject = log?.players.find((player) => player.tag === log.playerTag);
  const inScope = Boolean(log && subject && (scope === "self" ? isOwn(log.playerTag) : !isOwn(log.playerTag)));
  const modes = useMemo(() => {
    const seen = new Map<string, string>();
    for (const deck of log?.decks ?? []) for (const item of deck.modes) seen.set(modeKeyOf(item), displayMode(item.modeName));
    return [...seen.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [log]);
  const decks = useMemo(() => (inScope ? log!.decks : [])
    .filter((deck) => origin === "all" || deck.origin === origin)
    .filter((deck) => !mode || deck.modes.some((item) => modeKeyOf(item) === mode))
    .filter((deck) => deck.games >= minimumGames)
    .sort((left, right) => sort === "played" ? right.games - left.games || right.lastUsedAt.localeCompare(left.lastUsedAt)
      : sort === "winRate" ? (right.winRate ?? -1) - (left.winRate ?? -1) || right.games - left.games
        : right.lastUsedAt.localeCompare(left.lastUsedAt)), [inScope, log, minimumGames, mode, origin, sort]);

  const save = async (entry: TrackerDeckLogEntry, deck: DeckDefinition) => {
    if (!onSave || savingSignature) return;
    setSavingSignature(entry.signature);
    try { await onSave(deck); setSavedSignatures((current) => new Set([...current, entry.signature])); setError(""); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The deck could not be saved."); }
    finally { setSavingSignature(""); }
  };

  if (scope === "friends" && log && friends.length === 0) return null;
  const ownerLabel = subject?.displayName ?? "this player";
  return <section className="played-decks" aria-labelledby={`played-decks-${scope}`}>
    <div className="deck-library-section-heading"><div><h2 id={`played-decks-${scope}`}><History size={18} /> {scope === "self" ? "Decks you’ve played" : `Decks ${ownerLabel} has played`}</h2><p>Built automatically from recorded battles. Every distinct deck is listed once with its full record; decks a mode assigned (mirror, draft, pick) are kept apart from decks that were chosen.</p></div><span>{decks.length} {decks.length === 1 ? "deck" : "decks"}</span></div>
    <div className="played-deck-filters">
      {scope === "friends" && <label>Friend<select value={friendTag} onChange={(event) => { setFriendTag(event.target.value); setLimit(12); setMode(""); }}>{friends.map((player) => <option key={player.tag} value={player.tag}>{player.displayName}</option>)}</select></label>}
      <label>Decks<select value={origin} onChange={(event) => setOrigin(event.target.value as OriginFilter)}><option value="chosen">Chosen decks</option><option value="assigned">Assigned by a mode</option><option value="all">Everything</option></select></label>
      <label>Mode<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="">All modes</option>{modes.map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      <label>At least<select value={minimumGames} onChange={(event) => setMinimumGames(Number(event.target.value))}>{[1, 3, 5, 10, 25].map((value) => <option key={value} value={value}>{value} {value === 1 ? "game" : "games"}</option>)}</select></label>
      <label>Sort<select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}><option value="recent">Most recent</option><option value="played">Most played</option><option value="winRate">Win rate</option></select></label>
    </div>
    {error && <p role="alert" className="deck-save-error">{error}</p>}
    <div className="deck-library-list">
      {decks.slice(0, limit).map((entry) => <PlayedDeckRow key={`${entry.origin}:${entry.signature}`} entry={entry} deck={toDeckDefinition(entry, cardsById, ownerLabel)} catalog={catalog} cardsById={cardsById} cardsByKey={cardsByKey} onEdit={onEdit} onSave={onSave ? (deck) => void save(entry, deck) : undefined} onCopy={onCopy} saving={savingSignature === entry.signature} saved={savedSignatures.has(entry.signature)} />)}
      {decks.length > limit && <button className="deck-new library-load-more" onClick={() => setLimit((current) => current + 12)}>Show 12 more decks</button>}
      {!log && !error && <div className="deck-library-empty">Loading played decks…</div>}
      {log && !inScope && scope === "self" && <div className="deck-library-empty"><strong>No player tag on this account yet.</strong><span>Add your Clash Royale tag in account settings and every battle from then on builds this list automatically.</span></div>}
      {log && inScope && decks.length === 0 && <div className="deck-library-empty"><strong>No decks match these filters.</strong><span>{log.battlesWithDecks === 0 ? "Battles appear here a minute or two after they are played." : `${log.battlesWithDecks} recorded battles are outside the current filters.`}</span></div>}
    </div>
  </section>;
}
