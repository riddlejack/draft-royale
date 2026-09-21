import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, ExternalLink, Link2, Pencil, Plus, Search, Swords, Users, X } from "lucide-react";
import type { ArenaCard, ArenaCollection, DeckCollection, DeckDefinition, DeckMode, DeckSeedResponse, SocialCredential } from "@draft-royale/shared";
import { validateDeck } from "@draft-royale/shared";
import { ArenaCardFace } from "../components/ArenaCardFace";
import { DeckEditor } from "./DeckEditor";
import { PlayedDecks } from "./PlayedDecks";
import { clashDeckLink, clearSharedDeckLocation, cloneDeck, createDeckId, deckShareUrl, pairDecksFromSeed, pairShareUrl, readSavedDecks, sharedDeckFromLocation, sharedPairFromLocation, writeSavedDecks, deckElixirLabel } from "./deckUtils";
import { libraryRequest, persistDeck } from "./deckApi";
import "./deck-library.css";

type LibraryTab = DeckMode | "saved" | "community";
const tabs: Array<{ key: LibraryTab; label: string }> = [
  { key: "2v2", label: "2v2" },
  { key: "classic", label: "Classic" },
  { key: "chaos", label: "Chaos" },
  { key: "mirror", label: "Mirror" },
  { key: "saved", label: "My decks" },
  { key: "community", label: "Friends’ decks" },
];

const emptyDeck = (mode: DeckMode): DeckDefinition => ({
  id: createDeckId(), name: "Untitled deck", mode, cards: [], forms: {},
  source: { kind: "local", label: "Made in Deck Workshop" },
});

const timeLabel = (seconds?: number) => seconds === undefined ? "" : `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

function DeckCards({ deck, cardsByKey }: { deck: DeckDefinition; cardsByKey: ReadonlyMap<string, ArenaCard> }) {
  return <div className="library-card-row" aria-label={`${deck.name} cards`}>{deck.cards.map((key) => {
    const card = cardsByKey.get(key);
    const form = deck.forms?.[key] ?? "base";
    const formLabel = form === "base" ? card?.name : card?.forms.find((candidate) => candidate.key === form)?.label ?? `${card?.name} ${form}`;
    return card ? <span className={`library-card is-${form}`} key={key} title={formLabel} aria-label={formLabel}><ArenaCardFace card={card} form={form} /><span className="library-form-badge">{form === "evolution" ? "E" : form === "hero" ? "H" : form === "champion" ? "C" : ""}</span></span>
      : <span className="library-card-missing" key={key}>{key}</span>;
  })}</div>;
}

interface DeckRowProps {
  deck: DeckDefinition;
  catalog: readonly ArenaCard[];
  cardsByKey: ReadonlyMap<string, ArenaCard>;
  pairSelected?: boolean;
  onTogglePair?: () => void;
  onEdit: () => void;
  onCopy: (value: string, message: string) => void;
  onPublish?: () => void;
  onRemove?: () => void;
  busy?: boolean;
}

function DeckRow({ deck, catalog, cardsByKey, pairSelected, onTogglePair, onEdit, onCopy, onPublish, onRemove, busy }: DeckRowProps) {
  const validation = validateDeck(deck, catalog);
  const link = validation.valid ? clashDeckLink(deck, cardsByKey) : "";
  return <article className={`library-deck-row ${pairSelected ? "is-paired" : ""}`}>
    <div className="library-deck-title">
      <div><h3>{deck.name}</h3><p>{deck.description ?? deck.tags?.slice(0, 3).join(" · ") ?? "Eight-card deck"}</p></div>
      {onTogglePair && <button type="button" className="pair-select" aria-pressed={pairSelected} onClick={onTogglePair}>{pairSelected ? <><Check size={14} /> Paired</> : <><Users size={14} /> Pair</>}</button>}
    </div>
    <DeckCards deck={deck} cardsByKey={cardsByKey} />
    <footer className="library-deck-footer">
      <span className="library-elixir"><i aria-hidden="true" /> {deckElixirLabel(deck, catalog)}</span>
      <details className="library-source"><summary>Source details</summary><span>{deck.source.kind === "video" && timeLabel(deck.source.timestampSeconds) ? `${deck.source.label} · ${timeLabel(deck.source.timestampSeconds)}` : deck.source.label}</span>{/^https?:\/\//.test(deck.source.url ?? "") && <a href={deck.source.url} target="_blank" rel="noreferrer">Open source</a>}</details>
      <div className="library-deck-actions">
        <button type="button" onClick={onEdit} aria-label={`Edit ${deck.name}`}><Pencil size={14} /> Edit</button>
        <button type="button" onClick={() => onCopy(deckShareUrl(deck), "Deck share link copied.")} aria-label={`Share ${deck.name}`}><Link2 size={14} /> Share</button>
        {link && <button type="button" onClick={() => onCopy(link, `${deck.name} Clash link copied.`)}><Copy size={14} /> Copy</button>}
        {link && <a href={link} target="_blank" rel="noreferrer">Open <ExternalLink size={13} /></a>}
      </div>
    </footer>
    {(onPublish || onRemove) && <div className="library-owner-actions"><span>{deck.visibility === "public" ? "Published to friends" : deck.id.startsWith("deck_") ? "Saved to your account" : "Saved on this device"}</span>{onPublish && <button type="button" disabled={busy} onClick={onPublish}>{deck.visibility === "public" ? "Make private" : "Publish to friends"}</button>}{onRemove && <button type="button" disabled={busy} onClick={onRemove} aria-label={`Remove saved ${deck.name}`}>Remove</button>}</div>}
  </article>;
}

function PairBoard({ decks, cardsByKey, onCopy, onEdit, onRemove }: { decks: [DeckDefinition, DeckDefinition]; cardsByKey: ReadonlyMap<string, ArenaCard>; onCopy: (value: string, message: string) => void; onEdit: (deck: DeckDefinition) => void; onRemove: (id: string) => void }) {
  const links = decks.map((deck) => clashDeckLink(deck, cardsByKey));
  return <section className="teammate-pair" aria-labelledby="pair-title">
    <header><div><h2 id="pair-title">Your teammate pair</h2><p>Send one deck to each player, then queue together in Clash Royale.</p></div><button type="button" onClick={() => onCopy(pairShareUrl(decks), "Teammate pair link copied.")}><Link2 size={15} /> Share pair</button></header>
    <div className="teammate-pair-decks">{decks.map((deck, index) => <article key={`${deck.id}-${index}`}>
      <div className="pair-player"><span>{index === 0 ? "You" : "Teammate"}</span><strong>{deck.name}</strong><button type="button" onClick={() => onRemove(deck.id)} aria-label={`Remove ${deck.name} from pair`}><X size={14} /></button></div>
      <DeckCards deck={deck} cardsByKey={cardsByKey} />
      <div className="pair-actions"><button type="button" onClick={() => onEdit(deck)}><Pencil size={14} /> Edit</button>{links[index] && <button type="button" onClick={() => onCopy(links[index]!, `${index === 0 ? "Your" : "Teammate"} deck link copied.`)}><Copy size={14} /> Copy</button>}{links[index] && <a href={links[index]} target="_blank" rel="noreferrer">Open in Clash <ExternalLink size={13} /></a>}</div>
    </article>)}</div>
  </section>;
}

export function DeckLibrary({ catalog, collection, onBack, onCopy, credential, onMirror }: { catalog: readonly ArenaCard[]; collection: ArenaCollection; onBack: () => void; onCopy: (value: string, message: string) => void; credential?: SocialCredential | null; onMirror?: () => void }) {
  const sharedDeck = useMemo(sharedDeckFromLocation, []);
  const sharedPair = useMemo(sharedPairFromLocation, []);
  const [collections, setCollections] = useState<DeckCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [savedDecks, setSavedDecks] = useState(() => readSavedDecks(credential?.profileId));
  const [community, setCommunity] = useState<DeckDefinition[]>([]);
  const [collectionFilter, setCollectionFilter] = useState("all");
  const [limit, setLimit] = useState(24);
  const [actionError, setActionError] = useState("");
  const [busyId, setBusyId] = useState("");
  const operationIds = useRef(new Map<string, string>());
  const [tab, setTab] = useState<LibraryTab>(() => sharedDeck?.mode ?? (sharedPair ? "2v2" : "2v2"));
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<DeckDefinition | null>(() => sharedDeck ? cloneDeck(sharedDeck, { id: createDeckId(), source: { kind: "local", label: "Shared by a friend" } }) : null);
  const [pairDecks, setPairDecks] = useState<DeckDefinition[]>(() => sharedPair?.map((deck) => cloneDeck(deck)) ?? []);
  const cardsByKey = useMemo(() => new Map(catalog.map((card) => [card.key, card])), [catalog]);
  const createMode = (): DeckMode => tab === "saved" || tab === "community" ? "custom" : tab;

  useEffect(() => {
    let disposed = false;
    void libraryRequest<{ decks: DeckDefinition[] }>("/community", credential).then((data) => { if (!disposed) setCommunity(data.decks); }).catch(() => {});
    if (credential) void libraryRequest<{ decks: DeckDefinition[] }>("/mine", credential).then((data) => {
      if (!disposed) { const cached = readSavedDecks(credential.profileId).filter((deck) => !deck.id.startsWith("deck_")); const next = [...data.decks, ...cached]; setSavedDecks(next); writeSavedDecks(next, credential.profileId); }
    }).catch((failure: unknown) => { if (!disposed) setActionError(failure instanceof Error ? failure.message : "Saved decks could not sync."); });
    return () => { disposed = true; };
  }, [credential?.profileId, credential?.token]);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    void fetch("/api/decks/seeds", { signal: abort.signal })
      .then(async (response) => { if (!response.ok) throw new Error(`Deck library unavailable (${response.status})`); return response.json() as Promise<DeckSeedResponse>; })
      .then((response) => { setCollections(Array.isArray(response.collections) ? response.collections : []); setLoadError(""); })
      .catch((error: unknown) => { if (!abort.signal.aborted) setLoadError(error instanceof Error ? error.message : "Deck library unavailable"); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, []);

  const seededDecks = useMemo(() => collections.flatMap((collection) => [
    ...(collection.decks ?? []), ...pairDecksFromSeed(collection.pairs ?? []),
  ]), [collections]);
  const availableDecks = useMemo(() => (tab === "saved" ? savedDecks : tab === "community" ? community : [...seededDecks, ...savedDecks, ...community].filter((deck) => deck.mode === tab))
    .filter((deck, index, all) => all.findIndex((candidate) => candidate.id === deck.id) === index)
    .filter((deck) => collectionFilter === "all" || collections.find((item) => item.id === collectionFilter)?.decks?.some((item) => item.id === deck.id))
    .filter((deck) => !search.trim() || `${deck.name} ${deck.description ?? ""} ${(deck.tags ?? []).join(" ")} ${deck.cards.map((key) => cardsByKey.get(key)?.name ?? key).join(" ")}`.toLowerCase().includes(search.trim().toLowerCase())), [savedDecks, search, seededDecks, tab, community, collectionFilter, collections, cardsByKey]);
  const libraryCollection = collectionFilter === "all" ? collections.find((candidate) => candidate.mode === tab) : collections.find((candidate) => candidate.id === collectionFilter);

  const remember = (stored: DeckDefinition, oldId: string) => {
    const next = [stored, ...savedDecks.filter((candidate) => candidate.id !== oldId && candidate.id !== stored.id)];
    setSavedDecks(next); writeSavedDecks(next, credential?.profileId);
    setCommunity((current) => [...(stored.visibility === "public" ? [stored] : []), ...current.filter((candidate) => candidate.id !== stored.id)]);
  };
  const storeDeck = async (deck: DeckDefinition, visibility: "private" | "public") => {
    let stored = cloneDeck(deck, { updatedAt: new Date().toISOString() });
    if (credential) {
      const signature = JSON.stringify({ deck, visibility });
      let commandId = operationIds.current.get(signature);
      if (!commandId) { commandId = createDeckId(); operationIds.current.set(signature, commandId); }
      stored = (await persistDeck(deck, visibility, credential, commandId)).deck;
    }
    remember(stored, deck.id);
    return stored;
  };
  const saveDeck = async (deck: DeckDefinition) => {
    await storeDeck(deck, deck.visibility === "public" && deck.ownerId === credential?.profileId ? "public" : "private");
    setEditing(null); setTab("saved"); setCollectionFilter("all"); clearSharedDeckLocation();
  };
  const publishDeck = async (deck: DeckDefinition) => {
    if (!credential) { window.dispatchEvent(new Event("draft-royale:sign-in")); return; }
    if (busyId) return;
    setBusyId(deck.id); setActionError("");
    try { await storeDeck(deck, deck.visibility === "public" ? "private" : "public"); }
    catch (failure) { setActionError(failure instanceof Error ? failure.message : "Publishing failed."); }
    finally { setBusyId(""); }
  };
  const removeDeck = async (deck: DeckDefinition) => {
    if (busyId) return;
    setBusyId(deck.id); setActionError("");
    try {
      if (deck.id.startsWith("deck_") && credential) await libraryRequest(`/${encodeURIComponent(deck.id)}`, credential, undefined, "DELETE");
      const next = savedDecks.filter((candidate) => candidate.id !== deck.id); setSavedDecks(next); writeSavedDecks(next, credential?.profileId); setCommunity((current) => current.filter((candidate) => candidate.id !== deck.id));
    } catch (failure) { setActionError(failure instanceof Error ? failure.message : "Removal failed."); }
    finally { setBusyId(""); }
  };
  const editDeck = (deck: DeckDefinition) => setEditing(cloneDeck(deck, savedDecks.some((item) => item.id === deck.id) ? {} : { id: createDeckId(), ownerId: undefined, visibility: "private", name: `${deck.name.slice(0, 72)} remix`, source: { kind: "local", label: "Remixed in Deck Workshop" } }));
  const togglePair = (deck: DeckDefinition) => setPairDecks((current) => current.some((candidate) => candidate.id === deck.id)
    ? current.filter((candidate) => candidate.id !== deck.id)
    : [...current.slice(-1), deck]);

  if (editing) return <DeckEditor catalog={catalog} collection={collection} initialDeck={editing} onBack={() => { setEditing(null); clearSharedDeckLocation(); }} onSave={saveDeck} onCopy={onCopy} credential={credential} />;

  return <section className="deck-library-screen">
    <header className="deck-workshop-toolbar">
      <button type="button" className="deck-back" onClick={onBack} aria-label="Back to home"><ArrowLeft size={20} /></button>
      <div><h1>Deck Workshop</h1><span>Build, save and share</span></div>
      <button type="button" className="deck-new" onClick={() => setEditing(emptyDeck(createMode()))}><Plus size={16} /> New</button>
    </header>
    <div className="deck-library-intro"><div><h2>Build together. <span>Battle better.</span></h2><p>Choose a library deck or make your own eight-card lineup.</p></div></div>
    <nav className="deck-library-tabs" aria-label="Deck libraries">{tabs.map((item) => <button type="button" key={item.key} className={tab === item.key ? "is-active" : ""} aria-current={tab === item.key ? "page" : undefined} onClick={() => { setTab(item.key); setSearch(""); setCollectionFilter("all"); setLimit(24); }}>{item.label}</button>)}</nav>
    <label className="deck-library-search"><Search size={17} /><input value={search} onChange={(event) => { setSearch(event.target.value); setLimit(24); }} placeholder="Search decks, archetypes or cards…" aria-label="Search deck library" />{search && <button type="button" onClick={() => setSearch("")} aria-label="Clear search"><X size={15} /></button>}</label>
    {collections.filter((item) => item.mode === tab).length > 1 && <label className="library-collection-filter">Collection<select aria-label="Deck collection" value={collectionFilter} onChange={(event) => { setCollectionFilter(event.target.value); setLimit(24); }}><option value="all">All collections</option>{collections.filter((item) => item.mode === tab).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
    {tab === "mirror" && onMirror && <section className="pair-prompt"><Swords size={26} /><div><strong>Same deck. Settle it in the arena.</strong><span>Choose a shared deck, build one, or import a deck with a friend.</span></div><button className="deck-new" onClick={onMirror}>Start battle</button></section>}
    {tab === "saved" && !credential && <section className="library-sync-hint">These decks are saved on this device. <button onClick={() => window.dispatchEvent(new Event("draft-royale:sign-in"))}>Sign in to save to your player account</button></section>}
    {actionError && <p role="alert" className="deck-save-error">{actionError}</p>}

    {tab === "2v2" && pairDecks.length === 2 && <PairBoard decks={pairDecks as [DeckDefinition, DeckDefinition]} cardsByKey={cardsByKey} onCopy={onCopy} onEdit={editDeck} onRemove={(id) => setPairDecks((current) => current.filter((deck) => deck.id !== id))} />}
    {tab === "2v2" && pairDecks.length < 2 && <section className="pair-prompt"><Users size={26} /><div><strong>{pairDecks.length ? "Now choose your teammate’s deck" : "Build a teammate pair"}</strong><span>Pair the two bait decks shown together, or combine any two recommended decks.</span></div><b>{pairDecks.length}/2</b></section>}

    <div className="deck-library-section-heading"><div><h2>{tab === "saved" ? "My saved decks" : tab === "community" ? "Friends’ published decks" : libraryCollection?.title ?? tabs.find((item) => item.key === tab)?.label}</h2><p>{libraryCollection?.description ?? (tab === "saved" ? credential ? "Saved to your player account, ready on any signed-in device." : "Stored on this device and ready to remix." : tab === "community" ? "Decks your friends have shared with the site. Save a copy to make it your own." : "Create the first deck for this library.")}</p></div><span>{availableDecks.length} {availableDecks.length === 1 ? "deck" : "decks"}</span></div>
    <div className="deck-library-list">
      {availableDecks.slice(0, limit).map((deck) => <DeckRow key={deck.id} deck={deck} catalog={catalog} cardsByKey={cardsByKey} pairSelected={tab === "2v2" ? pairDecks.some((candidate) => candidate.id === deck.id) : undefined} onTogglePair={tab === "2v2" ? () => togglePair(deck) : undefined} onEdit={() => editDeck(deck)} onCopy={onCopy} onPublish={tab === "saved" ? () => void publishDeck(deck) : undefined} onRemove={tab === "saved" ? () => void removeDeck(deck) : undefined} busy={busyId === deck.id} />)}
      {availableDecks.length > limit && <button className="deck-new library-load-more" onClick={() => setLimit((current) => current + 24)}>Show 24 more decks</button>}
      {loading && <div className="deck-library-empty">Loading the deck library…</div>}
      {!loading && loadError && availableDecks.length === 0 && <div className="deck-library-empty"><strong>Deck library could not load.</strong><span>{loadError}</span></div>}
      {!loading && !loadError && availableDecks.length === 0 && tab === "community" && <div className="deck-library-empty"><Users size={27} /><strong>No friends have published a deck yet.</strong><span>Decks your friends publish appear here. Their played decks are listed below.</span></div>}
      {!loading && !loadError && availableDecks.length === 0 && tab !== "community" && <div className="deck-library-empty"><Swords size={27} /><strong>{tab === "mirror" ? "No curated Mirror decks yet." : "No decks here yet."}</strong><span>{tab === "mirror" ? "Create a deck or start a same-deck battle with a classic or community deck." : "Make one, save it, and send it to a friend."}</span>{tab === "mirror" && onMirror && <button type="button" onClick={onMirror}><Swords size={15} /> Start same-deck battle</button>}<button type="button" onClick={() => setEditing(emptyDeck(createMode()))}><Plus size={15} /> Create deck</button></div>}
    </div>
    {credential && (tab === "saved" || tab === "community") && <PlayedDecks key={tab} credential={credential} catalog={catalog} scope={tab === "saved" ? "self" : "friends"} onEdit={setEditing} onSave={(deck) => storeDeck(deck, "private")} onCopy={onCopy} />}
  </section>;
}
