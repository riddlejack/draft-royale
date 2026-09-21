import { useMemo, useState } from "react";
import { ArrowLeft, Check, Copy, ExternalLink, Link2, Save, Trash2 } from "lucide-react";
import type { ArenaCard, ArenaCollection, ArenaForm, DeckDefinition, DeckMode, SocialCredential, TrackerTally } from "@draft-royale/shared";
import { collectionAllowedForms, collectionOwnsCard, collectionOwnsForm, validateDeck, isChaosInfiniteElixirSupportedCard } from "@draft-royale/shared";
import { ArenaCardFace } from "../components/ArenaCardFace";
import { CardPicker } from "../components/CardPicker";
import { clashDeckLink, cloneDeck, deckCollectionIssues, deckShareUrl, parseDeckImport, deckElixirLabel } from "./deckUtils";
import { PICKER_BADGE_MIN_GAMES } from "../components/CardPicker";
import { recordSentence, useDeckStats, type DeckRecordState } from "./deckStats";

const modes: Array<{ key: DeckMode; label: string }> = [
  { key: "2v2", label: "2v2" },
  { key: "classic", label: "Classic" },
  { key: "chaos", label: "Chaos" },
  { key: "mirror", label: "Mirror" },
  { key: "custom", label: "Custom" },
];

interface DeckEditorProps {
  catalog: readonly ArenaCard[];
  collection: ArenaCollection;
  initialDeck: DeckDefinition;
  onBack: () => void;
  onSave: (deck: DeckDefinition) => void | Promise<void>;
  saveLabel?: string;
  onCopy: (value: string, message: string) => void;
  /** Signed-in players with a saved tag get their own card records in the builder; everyone else sees it unchanged. */
  credential?: SocialCredential | null;
}

const formatDay = (value: string) => { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date); };
const TallyLine = ({ label, tally }: { label: string; tally: TrackerTally }) => <p><span>{label}</span> <b>{recordSentence(tally)}</b></p>;

function ExactDeckRecord({ state }: { state: DeckRecordState }) {
  if (state.status === "idle") return null;
  const record = state.status === "ready" ? state.record : null;
  return <section className="deck-record" aria-live="polite" aria-label="Your record with this exact deck">
    <h3>Your record with this exact deck</h3>
    {state.status === "loading" ? <p className="deck-record-muted">Checking recorded battles…</p>
      : !record ? <p className="deck-record-muted">The record for this deck could not load.</p>
        : record.chosen.games + record.assigned.games === 0 ? <p className="deck-record-muted">You haven’t played this exact deck in a recorded battle yet.</p> : <>
          {record.chosen.games > 0 ? <TallyLine label="When you chose it:" tally={record.chosen} /> : null}
          {record.assigned.games > 0 ? <TallyLine label="When a mode assigned it (mirror, draft):" tally={record.assigned} /> : null}
          <ul aria-label="Most recent results">{record.recent.map((battle, index) => <li key={`${battle.battleTime}:${index}`}><i className={`deck-record-result is-${battle.result}`}>{battle.result === "win" ? "W" : battle.result === "loss" ? "L" : battle.result === "draw" ? "D" : "?"}</i><span>{battle.modeName.replace(/_/g, " ")}{battle.origin === "assigned" ? " · assigned" : ""}</span><time dateTime={battle.battleTime}>{formatDay(battle.battleTime)}</time></li>)}</ul>
        </>}
    <small>Same eight cards in any order. Evolved, hero and base copies of a card count as the same deck.</small>
  </section>;
}

export function DeckEditor({ catalog, collection, initialDeck, onBack, onSave, onCopy, saveLabel = "Save", credential }: DeckEditorProps) {
  const [deck, setDeck] = useState(() => cloneDeck(initialDeck));
  const [importValue, setImportValue] = useState("");
  const [importError, setImportError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const cardsByKey = useMemo(() => new Map(catalog.map((card) => [card.key, card])), [catalog]);
  const [focusedKey, setFocusedKey] = useState("");
  const playerStats = useDeckStats(credential, catalog, deck.cards, cardsByKey);
  const focusedStat = focusedKey && deck.cards.includes(focusedKey) ? playerStats.stats.get(focusedKey) : undefined;
  const validation = useMemo(() => validateDeck(deck, catalog), [catalog, deck]);
  const collectionIssues = useMemo(() => deckCollectionIssues(deck, catalog, collection), [catalog, collection, deck]);
  const modeError = deck.mode === "mirror" && !deck.cards.includes("mirror") ? "Mirror decks must include Mirror." : deck.mode === "chaos" && deck.cards.some((key) => {
    const card = cardsByKey.get(key);
    return !card || !isChaosInfiniteElixirSupportedCard(card) || (deck.forms?.[key] ?? "base") !== "base";
  }) ? "Chaos Infinite Elixir uses the available base cards only." : "";
  const valid = validation.valid && !modeError && collectionIssues.length === 0 && deck.name.trim().length > 0;
  const clashLink = valid ? clashDeckLink(deck, cardsByKey) : "";
  const save = async () => {
    if (!valid || saving) return;
    setSaving(true); setSaveError("");
    try { await onSave({ ...deck, tags: (deck.tags ?? []).map((tag) => tag.trim()).filter(Boolean) }); }
    catch (error) { setSaveError(error instanceof Error ? error.message : "Unable to save. Try again."); }
    finally { setSaving(false); }
  };

  const setCards = (cards: string[]) => {
    const forms: Partial<Record<string, ArenaForm>> = {};
    for (const key of cards) {
      const card = cardsByKey.get(key);
      forms[key] = deck.forms?.[key] ?? (card?.forms.some((candidate) => candidate.key === "base") ? "base" : card?.forms[0]?.key ?? "base");
    }
    setFocusedKey(cards.find((key) => !deck.cards.includes(key)) ?? (cards.includes(focusedKey) ? focusedKey : ""));
    setDeck((current) => ({ ...current, cards, forms }));
  };
  const setForm = (key: string, form: ArenaForm) => setDeck((current) => ({ ...current, forms: { ...current.forms, [key]: form } }));
  const importDeck = () => {
    const cards = parseDeckImport(importValue, catalog);
    if (!cards) { setImportError("Paste a valid Clash deck link, RoyaleAPI stats link, or eight card IDs."); return; }
    const forms = Object.fromEntries(cards.map((key) => {
      const card = cardsByKey.get(key);
      return [key, card?.forms.some((candidate) => candidate.key === "base") ? "base" : card?.forms[0]?.key ?? "base"];
    })) as Record<string, ArenaForm>;
    const issues = deckCollectionIssues({ cards, forms }, catalog, collection);
    if (issues.length) { setImportError(`That deck uses unavailable cards: ${issues.slice(0, 3).join(" ")}`); return; }
    setImportError("");
    setDeck((current) => ({ ...current, cards, forms }));
  };

  return <section className="deck-editor-screen">
    <header className="deck-workshop-toolbar">
      <button type="button" className="deck-back" disabled={saving} onClick={onBack} aria-label="Back to deck library"><ArrowLeft size={20} /></button>
      <div><h1>Edit deck</h1><span>{deck.cards.length}/8 cards</span></div>
      <button type="button" className="deck-save-top" disabled={!valid || saving} onClick={() => void save()}><Save size={15} /> {saving ? "Saving…" : saveLabel}</button>
    </header>

    <div className="deck-editor-layout">
      <div className="deck-editor-primary">
        <section className="deck-editor-settings">
          <label>Deck name<input value={deck.name} maxLength={80} onChange={(event) => setDeck((current) => ({ ...current, name: event.target.value }))} /></label>
          <label>Library<select value={deck.mode} onChange={(event) => setDeck((current) => ({ ...current, mode: event.target.value as DeckMode }))}>{modes.map((mode) => <option key={mode.key} value={mode.key}>{mode.label}</option>)}</select></label>
        </section>
        <section className="deck-editor-settings"><label>Notes<input value={deck.description ?? ""} maxLength={1000} placeholder="Game plan, teammate, or matchup notes" onChange={(event) => setDeck((current) => ({ ...current, description: event.target.value }))} /></label><label>Tags<input value={(deck.tags ?? []).join(", ")} maxLength={200} placeholder="Ladder, favorites, teammate" onChange={(event) => setDeck((current) => ({ ...current, tags: event.target.value.split(",").slice(0, 10).map((tag) => tag.trimStart()) }))} /></label></section>

        <section className="deck-slot-board" aria-label="Current deck">
          <div className="deck-slot-heading"><h2>Your deck</h2><span><i aria-hidden="true" /> <strong>{deckElixirLabel(deck, catalog)}</strong></span></div>
          <div className="deck-slots">
            {Array.from({ length: 8 }, (_, index) => {
              const key = deck.cards[index];
              const card = key ? cardsByKey.get(key) : null;
              if (!key || !card) return <div className="deck-slot-empty" key={index}><strong>{index + 1}</strong><span>Choose card</span></div>;
              const form = deck.forms?.[key] ?? "base";
              const legalForms = collectionAllowedForms(collection, card);
              const stat = playerStats.stats.get(key);
              const face = <ArenaCardFace card={card} form={form} legalForms={legalForms} />;
              return <article className={`deck-slot is-${form}${playerStats.hasCardStats && focusedKey === key ? " is-focused" : ""}`} key={key}>
                <button type="button" className="deck-slot-remove" onClick={() => setCards(deck.cards.filter((candidate) => candidate !== key))} aria-label={`Remove ${card.name}`}><Trash2 size={13} /></button>
                {playerStats.hasCardStats ? <button type="button" className="deck-slot-focus" aria-pressed={focusedKey === key} aria-label={`Show your record with and against ${card.name}`} onClick={() => setFocusedKey(focusedKey === key ? "" : key)}>{face}</button> : face}
                <strong>{card.name}</strong>
                {stat && stat.with.games >= PICKER_BADGE_MIN_GAMES ? <span className={`card-picker-stat${playerStats.picker.get(key)?.small ? " is-small" : ""}`} title={playerStats.picker.get(key)?.description}>{playerStats.picker.get(key)?.badge}</span> : null}
                <select value={form} aria-label={`${card.name} form`} onChange={(event) => setForm(key, event.target.value as ArenaForm)}>{card.forms.map((candidate) => <option key={candidate.key} value={candidate.key} disabled={!collectionOwnsForm(collection, key, candidate.key)}>{candidate.key === "base" ? "Base" : candidate.label.replace(card.name, "").trim() || candidate.key}{collectionOwnsForm(collection, key, candidate.key) ? "" : " · not owned"}</option>)}</select>
              </article>;
            })}
          </div>
          {playerStats.hasCardStats && deck.cards.length > 0 ? <p className="deck-stat-line" aria-live="polite">{focusedStat ? <><strong>{focusedStat.name}</strong> With it: <b>{recordSentence(focusedStat.with)}</b>. Against it: <b>{recordSentence(focusedStat.against)}</b>.</> : focusedKey && deck.cards.includes(focusedKey) ? <><strong>{cardsByKey.get(focusedKey)?.name}</strong> No recorded games with or against it in decks you built.</> : "Tap a card in your deck to see your record with it and against it. Badges show your win rate and games with the card, from decks you built."}</p> : null}
          <div className={`deck-validity ${valid ? "is-valid" : "is-invalid"}`} role="status">{valid ? <><Check size={15} /> Ready to play and share.</> : collectionIssues[0] ?? validation.errors[0] ?? (modeError || "Give this deck a name.")}</div>
          {saveError && <p className="deck-save-error" role="alert">{saveError}</p>}
          {playerStats.enabled ? <ExactDeckRecord state={playerStats.deckRecord} /> : null}
          <div className="deck-editor-actions">
            <button type="button" className="deck-action-secondary" onClick={() => setCards([])}>Clear</button>
            <button type="button" className="deck-action-secondary" disabled={!valid} onClick={() => onCopy(deckShareUrl(deck), "Share link copied.")}><Link2 size={16} /> Share</button>
            {clashLink && <a className="deck-action-gold" href={clashLink} target="_blank" rel="noreferrer">Open in Clash <ExternalLink size={15} /></a>}
          </div>
          {valid && Object.values(deck.forms ?? {}).some((form) => form !== "base") && <p className="deck-form-note">The link copies the eight cards in this order. Activate the marked Evolution, Hero, or Champion forms in their special slots after Clash Royale opens.</p>}
        </section>

        <details className="deck-import">
          <summary><Copy size={15} /> Import an existing deck</summary>
          <div><input value={importValue} onChange={(event) => setImportValue(event.target.value)} placeholder="Paste a Clash or RoyaleAPI deck link" aria-label="Deck link to import" /><button type="button" onClick={importDeck}>Import</button></div>
          {importError && <p role="alert">{importError}</p>}
        </details>
      </div>

      <aside className="deck-editor-picker">
        <CardPicker cards={catalog} selectedKeys={deck.cards} onSelectedKeysChange={setCards} maxSelected={8} title="Add cards" selectionLabel="cards" cardStats={playerStats.hasCardStats ? playerStats.picker : undefined} disabledKeys={catalog.filter((card) => !collectionOwnsCard(collection, card.key) || (deck.mode === "chaos" && !isChaosInfiniteElixirSupportedCard(card))).map((card) => card.key)} />
      </aside>
    </div>
  </section>;
}
