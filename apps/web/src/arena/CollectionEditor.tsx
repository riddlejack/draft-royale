import { useMemo, useState } from "react";
import type { ArenaCard, ArenaCollection, ArenaForm } from "@draft-royale/shared";
import { importArenaCollection } from "./client";

export const ALL_CARDS: ArenaCollection = { cards: null, forms: null, source: "unrestricted" };
const formName: Record<ArenaForm, string> = { base: "Base", evolution: "Evolution", hero: "Hero", champion: "Champion" };

export function CollectionEditor({ cards, value, onSave, onClose }: { cards: ArenaCard[]; value: ArenaCollection; onSave: (value: ArenaCollection) => void; onClose: () => void }) {
  const [collection, setCollection] = useState(value);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "special">("special");
  const [playerTag, setPlayerTag] = useState(value.profile?.tag ?? "");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [importNote, setImportNote] = useState("");
  const available = useMemo(() => cards.filter((card) => card.name.toLowerCase().includes(search.toLowerCase()) && (filter === "all" || card.forms.some((form) => form.key === "hero" || form.key === "evolution"))), [cards, search, filter]);
  const owns = (key: string) => collection.cards === null || collection.cards.includes(key);
  const hasForm = (key: string, form: ArenaForm) => collection.forms === null || collection.forms[key]?.includes(form);
  const manual = (current: ArenaCollection, next: Pick<ArenaCollection, "cards" | "forms">): ArenaCollection => ({ ...next, source: "manual" });
  const toggleCard = (key: string) => setCollection((current) => {
    const next = new Set(current.cards ?? cards.map((card) => card.key));
    if (next.has(key)) next.delete(key); else next.add(key);
    return manual(current, { cards: [...next], forms: current.forms });
  });
  const toggleForm = (key: string, form: ArenaForm) => setCollection((current) => {
    const all = current.forms ?? Object.fromEntries(cards.map((card) => [card.key, card.forms.map((item) => item.key)]));
    const next = new Set(all[key] ?? []);
    if (next.has(form)) next.delete(form); else next.add(form);
    return manual(current, { cards: current.cards, forms: { ...all, [key]: [...next] } });
  });
  const importCollection = async () => {
    if (importing) return;
    setImporting(true); setImportError(""); setImportWarnings([]); setImportNote("");
    try {
      const result = await importArenaCollection(playerTag);
      setCollection(result.collection);
      setPlayerTag(result.collection.profile?.tag ?? playerTag);
      setImportWarnings(result.warnings);
      setImportNote(`${result.collection.profile?.name ?? "Player"} · ${result.collection.cards?.length ?? 0} cards · ${result.stale ? "saved API result" : result.cached ? "recent API result" : "just synced"}`);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Collection import failed. Your saved collection was not changed.");
    } finally { setImporting(false); }
  };
  return <div className="arena-modal-backdrop" onClick={onClose}>
    <section className="arena-modal collection-modal" role="dialog" aria-modal="true" aria-labelledby="collection-title" onClick={(event) => event.stopPropagation()}>
      <header className="modal-heading"><h2 id="collection-title">My cards</h2><button className="icon-button" onClick={onClose} aria-label="Close collection">×</button></header>
      <p className="muted">Choose the cards and forms you can use in friendly battles and Deck Workshop.</p>
      <form className="collection-import" onSubmit={(event) => { event.preventDefault(); void importCollection(); }}>
        <label>Import public profile<div><input value={playerTag} onChange={(event) => setPlayerTag(event.target.value)} placeholder="#PLAYER_TAG" autoCapitalize="characters" autoComplete="off" aria-label="Clash Royale player tag" /><button type="submit" className="small-button" disabled={importing || !playerTag.trim()}>{importing ? "Syncing…" : "Import"}</button></div></label>
        <small>This reads the public profile for a player tag. It does not verify that you own the account. Your existing selection stays saved if the API is offline.</small>
        {importError && <p role="alert" className="collection-import-error">{importError}</p>}
        {importNote && <p role="status" className="collection-import-note">{importNote}. Review it below, then save.</p>}
        {importWarnings.map((warning) => <p className="collection-import-warning" key={warning}>{warning}</p>)}
      </form>
      <div className="collection-actions">
        <button className="small-button" onClick={() => setCollection(ALL_CARDS)}>All unlocked</button>
        <button className="small-button" onClick={() => setCollection({ cards: null, forms: {}, source: "manual" })}>Base cards only</button>
      </div>
      <div className="collection-filters"><input aria-label="Search collection" placeholder="Find a card…" value={search} onChange={(event) => setSearch(event.target.value)} /><select aria-label="Collection filter" value={filter} onChange={(event) => setFilter(event.target.value as "all" | "special")}><option value="special">Evos & Heroes</option><option value="all">All cards</option></select></div>
      <div className="collection-list">{available.map((card) => <article className={`collection-card ${owns(card.key) ? "" : "unowned"}`} key={card.key}>
        <button className="collection-identity" onClick={() => toggleCard(card.key)} aria-label={`${owns(card.key) ? "Remove" : "Add"} ${card.name}`} aria-pressed={owns(card.key)}>
          <img src={card.forms[0]?.asset} alt="" loading="lazy" /><span>{card.name}<small>{owns(card.key) ? "Owned" : "Not owned"}</small></span><span className="collection-check">{owns(card.key) ? "✓" : "+"}</span>
        </button>
        {owns(card.key) && card.forms.some((form) => form.key === "evolution" || form.key === "hero") && <div className="collection-forms">{card.forms.filter((form) => form.key === "evolution" || form.key === "hero").map((form) => <button key={form.key} aria-pressed={Boolean(hasForm(card.key, form.key))} onClick={() => toggleForm(card.key, form.key)} className={hasForm(card.key, form.key) ? `form-owned ${form.key}` : ""}>{formName[form.key]} {hasForm(card.key, form.key) ? "✓" : "+"}</button>)}</div>}
      </article>)}</div>
      <footer className="modal-footer"><span className="muted">{collection.cards?.length ?? cards.length} cards · {collection.source === "unrestricted" ? "All forms" : collection.source === "api" ? `${collection.profile?.name ?? "API"} · synced ${collection.profile?.fetchedAt ? new Date(collection.profile.fetchedAt).toLocaleString() : "recently"}` : "Custom collection"}</span><button className="royale-button gold" onClick={() => onSave(collection)}>Save collection</button></footer>
    </section>
  </div>;
}
