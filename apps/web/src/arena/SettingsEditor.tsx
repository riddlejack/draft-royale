import { useMemo, useState } from "react";
import { ARENA_MEGA_MIN_POOL_SIZE, ARENA_MEGA_MAX_POOL_SIZE, CHAOS_MODIFIER_CARD_COUNT, CHAOS_MODIFIER_POOL_SOURCE, CHAOS_POOL_CARD_COUNT, CHAOS_POOL_SOURCE, isArenaCardHardEligible, isChaosBattleMode, isChaosInfiniteElixirBattleMode, shouldPresetMirrorCard, arenaElixirRanges, effectiveMegaPoolSize, filterArenaCards, filterArenaCardsBeforeOverrides, type ArenaCard, type ArenaSettings } from "@draft-royale/shared";
import { deleteSavedSetup, readSavedSetups, saveSetupCopy, type SavedBattleSetup } from "./savedSetups";
import { CardPicker } from "./components/CardPicker";
import "./PoolEditor.css";

interface SettingsEditorProps {
  cards: ArenaCard[];
  value: ArenaSettings;
  onSave: (value: ArenaSettings) => void;
  onClose: () => void;
}

type ListFilter = "cardKinds" | "rarities" | "families";
const modeLabel = { mega: "Mega Draft", triple: "Triple Draft", classic: "Classic Draft" } as const;
const pickSecondOptions = [15, 30, 60] as const;
const poolSizeOptions = Array.from({ length: ARENA_MEGA_MAX_POOL_SIZE - ARENA_MEGA_MIN_POOL_SIZE + 1 }, (_, index) => ARENA_MEGA_MIN_POOL_SIZE + index);
const elixirPresets = [{ label: "Any", min: undefined, max: undefined }, { label: "1–3", min: 1, max: 3 }, { label: "4–6", min: 4, max: 6 }, { label: "7–10", min: 7, max: 10 }];
const battleModeOptions = ["Friendly 1v1", "Chaos Infinite Elixir", "Double Elixir", "Triple Elixir", "7× Elixir", "Other friendly mode"] as const;
const orderFrom = (preferred: readonly string[]) => (left: string, right: string) => {
  const leftIndex = preferred.indexOf(left);
  const rightIndex = preferred.indexOf(right);
  if (leftIndex >= 0 || rightIndex >= 0) return (leftIndex < 0 ? preferred.length : leftIndex) - (rightIndex < 0 ? preferred.length : rightIndex);
  return left.localeCompare(right);
};
const title = (value: string) => ({
  "anti-air": "Anti-Air",
  "skeleton-bones": "Skeletons & Bones",
  "noble-royal": "Nobles & Royals",
  "siege-mechanical": "Siege & Machines",
}[value] ?? value.split("-").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" "));
const hasPoolFilters = (settings: ArenaSettings) => arenaElixirRanges(settings).length > 0
  || Boolean(settings.cardKinds?.length)
  || Boolean(settings.rarities?.length)
  || Boolean(settings.families?.length)
  || settings.includeCards !== undefined
  || settings.excludeCards !== undefined;
const cloneSettings = (settings: ArenaSettings): ArenaSettings => JSON.parse(JSON.stringify(settings)) as ArenaSettings;
const withBattleModeRules = (settings: ArenaSettings): ArenaSettings => isChaosInfiniteElixirBattleMode(settings.battleMode)
  ? { ...settings, specialForms: false, groupedSpecialRounds: false }
  : settings;

export function SettingsEditor({ cards, value, onSave, onClose }: SettingsEditorProps) {
  const [settings, setSettings] = useState<ArenaSettings>(() => withBattleModeRules({ ...value, mirrorMode: value.mirrorMode ?? false, poolSize: Math.min(value.poolSize, ARENA_MEGA_MAX_POOL_SIZE) }));
  const [filtersOpen, setFiltersOpen] = useState(() => hasPoolFilters(value));
  const [poolEditorOpen, setPoolEditorOpen] = useState(() => Boolean(value.includedCardIds?.length || value.excludedCardIds?.length));
  const [savedUi, setSavedUi] = useState(() => {
    const loaded = readSavedSetups();
    return { setups: loaded.setups, message: loaded.error ?? "", isError: Boolean(loaded.error) };
  });
  const [savedOpen, setSavedOpen] = useState(false);
  const [selectedSetupId, setSelectedSetupId] = useState("");
  const [setupName, setSetupName] = useState("");
  const [customMin, setCustomMin] = useState(1);
  const [customMax, setCustomMax] = useState(3);
  const elixirRanges = arenaElixirRanges(settings);
  const setElixirRanges = (ranges: ArenaSettings["elixirRanges"]) => setSettings((current) => ({ ...current, minElixir: undefined, maxElixir: undefined, elixirRanges: ranges }));
  const toggleElixirRange = (min: number, max: number) => {
    const selected = elixirRanges.some((range) => range.min === min && range.max === max);
    if (selected) setElixirRanges(elixirRanges.filter((range) => range.min !== min || range.max !== max));
    else if (elixirRanges.length < 32) setElixirRanges([...elixirRanges, { min, max }].sort((a, b) => a.min - b.min || a.max - b.max));
  };

  const options = useMemo(() => ({
    cardKinds: Array.from(new Set(cards.map((card) => card.kind))).sort(orderFrom(["troop", "spell", "building"])),
    rarities: Array.from(new Set(cards.map((card) => card.rarity))).sort(orderFrom(["common", "rare", "epic", "legendary", "champion"])),
    families: Array.from(new Set(cards.flatMap((card) => card.families))).sort(orderFrom(["goblin", "skeleton-bones", "noble-royal", "flying", "anti-air", "fire", "electric"])),
  }), [cards]);
  const hardEligibleCards = useMemo(() => cards.filter((card) => isArenaCardHardEligible(card, settings)), [cards, settings]);
  const baselineCards = useMemo(() => filterArenaCardsBeforeOverrides(cards, settings), [cards, settings]);
  const eligibleCards = useMemo(() => filterArenaCards(cards, settings), [cards, settings]);
  const baselineIds = useMemo(() => new Set(baselineCards.map((card) => card.id)), [baselineCards]);
  const eligibleIds = useMemo(() => new Set(eligibleCards.map((card) => card.id)), [eligibleCards]);
  const hardEligibleIds = useMemo(() => new Set(hardEligibleCards.map((card) => card.id)), [hardEligibleCards]);
  const manuallyAdded = eligibleCards.filter((card) => !baselineIds.has(card.id));
  const manuallyRemoved = baselineCards.filter((card) => !eligibleIds.has(card.id));
  const unavailableOverrideCount = (settings.includedCardIds ?? []).filter((id) => !hardEligibleIds.has(id)).length;
  const hardIneligibleKeys = cards.filter((card) => !hardEligibleIds.has(card.id)).map((card) => card.key);
  const chaos = isChaosBattleMode(settings.battleMode);
  const infiniteElixir = isChaosInfiniteElixirBattleMode(settings.battleMode);
  const mirror = Boolean(settings.mirrorMode);
  const presetMirror = shouldPresetMirrorCard(settings);
  const requiredCards = settings.mode === "triple" ? mirror ? presetMirror ? 21 : 24 : 48 : settings.mode === "classic" && presetMirror ? 14 : ARENA_MEGA_MIN_POOL_SIZE;
  const dealtCards = effectiveMegaPoolSize(settings, eligibleCards.length);
  const invalidRange = settings.minElixir !== undefined && settings.maxElixir !== undefined && settings.minElixir > settings.maxElixir;
  const catalogUnavailable = cards.length === 0;
  const tooSmall = !catalogUnavailable && eligibleCards.length < requiredCards;
  const grouped = settings.mode === "triple" && settings.specialForms && settings.groupedSpecialRounds;
  const groupedRequirements = mirror ? { evolution: 6, heroChampion: 3, base: presetMirror ? 12 : 15 } : { evolution: 12, heroChampion: 6, base: 30 };
  const groupedShortage = grouped && !catalogUnavailable && (
    eligibleCards.filter((card) => card.forms.some((form) => form.key === "evolution")).length < groupedRequirements.evolution
    || eligibleCards.filter((card) => card.forms.some((form) => form.key === "hero" || form.key === "champion")).length < groupedRequirements.heroChampion
    || eligibleCards.filter((card) => card.forms.some((form) => form.key === "base")).length < groupedRequirements.base
  );
  const blockingMessage = catalogUnavailable
    ? "Card data is still loading."
    : invalidRange
      ? "Minimum elixir cannot be higher than maximum elixir."
      : tooSmall
        ? `${modeLabel[settings.mode]} needs at least ${requiredCards} eligible cards.`
        : groupedShortage
          ? `These filters leave too few choices for grouped rounds. ${mirror ? "Mirror mode needs" : "Both players together need"} ${groupedRequirements.evolution} Evolution, ${groupedRequirements.heroChampion} Hero/Champion, and ${groupedRequirements.base} regular options. Widen the pool or turn grouping off.`
          : "";
  const filterCount = elixirRanges.length
    + (settings.cardKinds?.length ?? 0)
    + (settings.rarities?.length ?? 0)
    + (settings.families?.length ?? 0)
    + (settings.includeCards === undefined ? 0 : 1)
    + (settings.excludeCards === undefined ? 0 : 1);

  const toggleFilter = (key: ListFilter, option: string) => setSettings((current) => {
    const selected = current[key] ?? [];
    return { ...current, [key]: selected.includes(option) ? selected.filter((value) => value !== option) : [...selected, option] };
  });
  const resetFilters = () => setSettings((current) => {
    const next = { ...current };
    delete next.minElixir;
    delete next.maxElixir;
    delete next.elixirRanges;
    delete next.cardKinds;
    delete next.rarities;
    delete next.families;
    delete next.includeCards;
    delete next.excludeCards;
    return next;
  });
  const setExactPool = (selectedKeys: string[]) => setSettings((current) => {
    const selected = new Set(selectedKeys);
    const currentBaseline = filterArenaCardsBeforeOverrides(cards, current);
    const currentHardEligible = cards.filter((card) => isArenaCardHardEligible(card, current));
    const currentBaselineKeys = new Set(currentBaseline.map((card) => card.key));
    const includedCardIds = currentHardEligible.filter((card) => selected.has(card.key) && !currentBaselineKeys.has(card.key)).map((card) => card.id);
    const excludedCardIds = currentBaseline.filter((card) => !selected.has(card.key)).map((card) => card.id);
    return {
      ...current,
      includedCardIds: includedCardIds.length ? includedCardIds : undefined,
      excludedCardIds: excludedCardIds.length ? excludedCardIds : undefined,
    };
  });
  const resetPoolOverrides = () => setSettings((current) => {
    const next = { ...current };
    delete next.includedCardIds;
    delete next.excludedCardIds;
    return next;
  });
  const loadSetup = () => {
    const setup = savedUi.setups.find((candidate) => candidate.id === selectedSetupId);
    if (!setup) return;
    setSettings(withBattleModeRules(cloneSettings(setup.settings)));
    setFiltersOpen(hasPoolFilters(setup.settings));
    setPoolEditorOpen(Boolean(setup.settings.includedCardIds?.length || setup.settings.excludedCardIds?.length));
    setSavedUi((current) => ({ ...current, message: `${setup.name} loaded. Tap Use these rules to apply it.`, isError: false }));
  };
  const saveCopy = () => {
    const result = saveSetupCopy(savedUi.setups, setupName, settings);
    if (result.error || !result.saved) {
      setSavedUi((current) => ({ ...current, message: result.error ?? "This setup could not be saved.", isError: true }));
      return;
    }
    setSelectedSetupId(result.saved.id);
    setSetupName("");
    setSavedUi({ setups: result.setups, message: `${result.saved.name} saved on this device.`, isError: false });
  };
  const removeSetup = () => {
    if (!selectedSetupId) return;
    const selected = savedUi.setups.find((setup) => setup.id === selectedSetupId);
    const result = deleteSavedSetup(savedUi.setups, selectedSetupId);
    if (result.error) {
      const message = result.error;
      setSavedUi((current) => ({ ...current, message, isError: true }));
      return;
    }
    setSelectedSetupId("");
    setSavedUi({ setups: result.setups, message: selected ? `${selected.name} deleted.` : "Saved setup deleted.", isError: false });
  };
  const chipGroup = (legend: string, key: ListFilter, values: string[]) => values.length > 0 && <fieldset className="pool-chip-group">
    <legend>{legend}</legend>
    <div className="pool-chips">{values.map((option) => <button type="button" key={option} className={(settings[key] ?? []).includes(option) ? "active" : ""} aria-pressed={(settings[key] ?? []).includes(option)} onClick={() => toggleFilter(key, option)}>{title(option)}</button>)}</div>
  </fieldset>;

  return <div className="arena-modal-backdrop" onClick={onClose}><section className="arena-modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="rules-title" onClick={(event) => event.stopPropagation()}>
    <header className="modal-heading"><h2 id="rules-title">Battle rules</h2><button type="button" className="icon-button" onClick={onClose} aria-label="Close rules">×</button></header>

    <section className={`saved-setups ${savedUi.isError ? "has-error" : ""}`} aria-labelledby="saved-setups-title">
      <button type="button" className="saved-setup-toggle" aria-expanded={savedOpen} aria-controls="saved-setup-controls" onClick={() => setSavedOpen((open) => !open)}>
        <span className="saved-setup-heading"><strong id="saved-setups-title">Saved battles</strong><small>{savedUi.isError && !savedOpen ? savedUi.message : "Keep favorite rules on this device."}</small></span>
        <span className="saved-setup-count">{savedUi.setups.length}/12</span><span className="saved-setup-toggle-icon" aria-hidden="true">{savedOpen ? "−" : "+"}</span>
      </button>
      {savedOpen && <div className="saved-setup-controls" id="saved-setup-controls">
        <div className="saved-setup-picker">
          <select aria-label="Saved battle setup" value={selectedSetupId} onChange={(event) => setSelectedSetupId(event.target.value)}>
            <option value="">Choose a saved setup</option>
            {savedUi.setups.map((setup: SavedBattleSetup) => <option key={setup.id} value={setup.id}>{setup.name} · {modeLabel[setup.settings.mode]}</option>)}
          </select>
          <button type="button" className="small-button" disabled={!selectedSetupId} onClick={loadSetup}>Load</button>
          <button type="button" className="saved-delete" disabled={!selectedSetupId} onClick={removeSetup} aria-label="Delete selected saved setup">Delete</button>
        </div>
        <div className="saved-setup-create"><input aria-label="Saved setup name" maxLength={40} value={setupName} onChange={(event) => setSetupName(event.target.value)} placeholder="Name these rules" /><button type="button" className="small-button" disabled={!setupName.trim() || Boolean(blockingMessage)} onClick={saveCopy}>Save copy</button></div>
        {savedUi.message && <p className={`setup-message ${savedUi.isError ? "is-error" : ""}`} role={savedUi.isError ? "alert" : "status"}>{savedUi.message}</p>}
      </div>}
    </section>

    <label className="setting-row"><span>Draft clock<small>{settings.timerMode === "whole_draft" ? "One shared countdown for all choices" : "Each pick gets a fresh countdown"}</small></span><select aria-label="Draft clock" value={settings.timerMode ?? "per_pick"} onChange={(event) => setSettings({ ...settings, timerMode: event.target.value as "per_pick" | "whole_draft" })}><option value="per_pick">Per pick</option><option value="whole_draft">Whole draft</option></select></label>
    <label className="setting-row"><span>Time limit</span><select aria-label="Time limit" value={settings.pickSeconds} onChange={(event) => setSettings({ ...settings, pickSeconds: Number(event.target.value) })}>{!pickSecondOptions.includes(settings.pickSeconds as typeof pickSecondOptions[number]) && <option value={settings.pickSeconds}>{settings.pickSeconds} seconds · saved</option>}{pickSecondOptions.map((seconds) => <option value={seconds} key={seconds}>{seconds} seconds</option>)}</select></label>
    <label className="setting-row"><span>Mirror mode<small>{chaos ? "Draft the same deck together. The Mirror card is unavailable in Chaos." : "Mirror is included. Take turns drafting seven more cards."}</small></span><input className="royale-switch" type="checkbox" aria-label="Mirror mode" checked={mirror} onChange={(event) => setSettings({ ...settings, mirrorMode: event.target.checked })} /></label>
    <label className="setting-row"><span>Special cards<small>{infiniteElixir ? "Unavailable in the current Infinite Elixir pool" : "Evolutions, Heroes & Champions"}</small></span><input className="royale-switch" type="checkbox" disabled={infiniteElixir} checked={!infiniteElixir && settings.specialForms} onChange={(event) => setSettings({ ...settings, specialForms: event.target.checked })} /></label>
    {settings.mode === "triple" && <label className="setting-row"><span>Group special rounds<small>{infiniteElixir ? "Unavailable with base-only Infinite Elixir cards." : "Two Evolution picks, then one Hero/Champion pick."}</small></span><input className="royale-switch" type="checkbox" aria-label="Group special rounds" disabled={infiniteElixir || !settings.specialForms} checked={!infiniteElixir && settings.specialForms && Boolean(settings.groupedSpecialRounds)} onChange={(event) => setSettings({ ...settings, groupedSpecialRounds: event.target.checked })} /></label>}
    {settings.mode === "triple" && settings.specialForms && settings.groupedSpecialRounds && <p className="grouped-rules-note">{mirror ? `Players alternate through two shared Evolution rounds, one shared Hero/Champion round, then ${presetMirror ? "four" : "five"} regular rounds.` : "Both players get three choices in each special round, followed by five regular picks."} The Wild slot holds your second Evolution. Your filters and both collections must support this schedule.</p>}
    {!infiniteElixir && <div className="slot-explanation"><span className="evolution">◆ Evolution</span><span className="hero">★ Hero</span><span>✦ Wild</span><p>One Evolution slot, one Hero/Champion slot, and a Wild slot for either. Maximum one Champion and two Heroes/Champions combined. Available forms depend on your collection.</p></div>}

    <section className="setting-section pool-section" aria-labelledby="card-pool-title">
      <div className="setting-section-heading"><div><h3 id="card-pool-title">Card pool</h3><p className={blockingMessage ? "is-blocked" : ""} aria-live="polite">{catalogUnavailable ? "Loading card catalog…" : <><strong>{eligibleCards.length}</strong> eligible · {settings.mode === "mega" && !tooSmall ? `${dealtCards} on board` : `${requiredCards} needed`}</>}</p></div><button type="button" className="pool-filter-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}>{filterCount ? `${filterCount} active` : "All cards"}<span>{filtersOpen ? "−" : "+"}</span></button></div>
      {infiniteElixir
        ? <p className="chaos-pool-note" role="status"><strong>Infinite Elixir pool</strong> · {CHAOS_POOL_CARD_COUNT} base cards before your filters. Checked September 6. <a href={CHAOS_POOL_SOURCE} target="_blank" rel="noreferrer">Mode source ↗</a></p>
        : chaos && <p className="chaos-pool-note" role="status"><strong>Chaos modifier pool</strong> · {CHAOS_MODIFIER_CARD_COUNT} observed cards before your filters. <a href={CHAOS_MODIFIER_POOL_SOURCE} target="_blank" rel="noreferrer">Broad source ↗</a></p>}
      {settings.mode === "mega" && <label className="setting-row"><span>Maximum cards<small>Uses fewer when filters narrow the pool.</small></span><select aria-label="Maximum Mega Draft cards" value={settings.poolSize} onChange={(event) => setSettings({ ...settings, poolSize: Number(event.target.value) })}>{poolSizeOptions.map((size) => <option value={size} key={size}>{size}</option>)}</select></label>}
      <fieldset className="elixir-filter">
        <legend>Elixir ranges</legend>
        <div className="pool-chips elixir-presets">{elixirPresets.map((preset) => {
          const selected = preset.min === undefined ? elixirRanges.length === 0 : elixirRanges.some((range) => range.min === preset.min && range.max === preset.max);
          return <button type="button" key={preset.label} className={selected ? "active" : ""} aria-pressed={selected} aria-label={preset.label === "Any" ? "Any elixir cost" : `${preset.min} to ${preset.max} elixir`} onClick={() => preset.min === undefined || preset.max === undefined ? setElixirRanges([]) : toggleElixirRange(preset.min, preset.max)}>{preset.label}</button>;
        })}</div>
        <p className="pool-filter-help">Select multiple ranges to include either. For example, 1–3 plus 7–10 skips 4–6.</p>
        <div className="elixir-range"><label>Minimum<select aria-label="Minimum elixir" value={customMin} onChange={(event) => setCustomMin(Number(event.target.value))}>{Array.from({ length: 11 }, (_, option) => <option key={option} value={option}>{option}</option>)}</select></label><label>Maximum<select aria-label="Maximum elixir" value={customMax} onChange={(event) => setCustomMax(Number(event.target.value))}>{Array.from({ length: 11 }, (_, option) => <option key={option} value={option}>{option}</option>)}</select></label></div>
        <button type="button" className="small-button elixir-add" disabled={customMin > customMax || elixirRanges.length >= 32 || elixirRanges.some((range) => range.min === customMin && range.max === customMax)} onClick={() => toggleElixirRange(customMin, customMax)}>Add {customMin}–{customMax} range</button>
        {elixirRanges.length > 0 && <div className="pool-chips elixir-selected" aria-label="Selected elixir ranges">{elixirRanges.map((range, index) => <button type="button" className="active" key={`${range.min}-${range.max}-${index}`} aria-label={`Remove ${range.min} to ${range.max} elixir range`} onClick={() => setElixirRanges(elixirRanges.filter((_, i) => i !== index))}>{range.min}–{range.max} <span aria-hidden="true">×</span></button>)}</div>}
        <p className="pool-filter-help">{elixirRanges.length ? `Included: ${elixirRanges.map((range) => `${range.min}–${range.max}`).join(" or ")} elixir. Both limits included.` : "All elixir costs included."}</p>
      </fieldset>
      {filtersOpen && <div className="pool-filter-panel">
        <p className="pool-filter-help">Choose more than one option in a group to include either. Filters from different groups narrow the pool together.</p>
        {chipGroup("Card type", "cardKinds", options.cardKinds)}
        {chipGroup("Rarity", "rarities", options.rarities)}
        {chipGroup("Curated themes", "families", options.families)}
        <div className="pool-filter-actions"><p>Theme labels are hand-picked for this companion.</p><button type="button" className="text-button" disabled={!hasPoolFilters(settings)} onClick={resetFilters}>Reset card filters</button></div>
      </div>}
      <section className="exact-pool-editor" aria-labelledby="exact-pool-title">
        <button type="button" className="exact-pool-toggle" aria-expanded={poolEditorOpen} aria-controls="exact-pool-controls" onClick={() => setPoolEditorOpen((open) => !open)}>
          <span><strong id="exact-pool-title">Edit exact card pool</strong><small>Review every card after filters</small></span>
          <span className="exact-pool-counts">{manuallyAdded.length} added / {manuallyRemoved.length} removed</span>
          <span className="exact-pool-toggle-icon" aria-hidden="true">{poolEditorOpen ? "−" : "+"}</span>
        </button>
        {unavailableOverrideCount > 0 && <p className="pool-unavailable-note" role="status">{unavailableOverrideCount} saved {unavailableOverrideCount === 1 ? "addition is" : "additions are"} unavailable under this mode's fixed rules. It will return if those rules change.</p>}
        {poolEditorOpen && <div className="exact-pool-controls" id="exact-pool-controls">
          <div className="exact-pool-copy"><p>Filters create the starting pool. Tap cards to make final additions or removals. Fixed mode restrictions and player collections still apply.</p><button type="button" className="text-button" disabled={!settings.includedCardIds?.length && !settings.excludedCardIds?.length} onClick={resetPoolOverrides}>Reset edits</button></div>
          <CardPicker
            cards={cards}
            selectedKeys={eligibleCards.map((card) => card.key)}
            onSelectedKeysChange={setExactPool}
            title="Available cards"
            selectionLabel="cards in pool"
            disabledKeys={hardIneligibleKeys}
            compact
            showSelectedFirst
          />
        </div>}
      </section>
      <p className="pool-eligibility-note">{mirror ? presetMirror ? "Mirror is included outside these filters. Both players need Mirror and every dealt card and form in their collections." : "Both players must share every dealt card and form. The room checks both collections before starting." : "Both players must have enough available cards and forms to draft with these rules."}</p>
      {blockingMessage && <p className="rules-blocker" role="alert">{blockingMessage}</p>}
    </section>

    <label className="setting-section battle-mode-section"><h3>Play in Clash Royale</h3><select aria-label="Intended friendly battle" value={settings.battleMode} onChange={(event) => setSettings((current) => withBattleModeRules({ ...current, battleMode: event.target.value }))}>{!battleModeOptions.includes(settings.battleMode as typeof battleModeOptions[number]) && <option value={settings.battleMode}>{settings.battleMode} · saved</option>}{battleModeOptions.map((battleMode) => <option key={battleMode} value={battleMode}>{battleMode}</option>)}</select><p className="muted">Choose this mode inside Clash Royale after importing your decks. Available friendly modes can change.</p></label>
    <div className="settings-apply"><button type="button" className="royale-button gold full-width" disabled={Boolean(blockingMessage)} onClick={() => onSave(withBattleModeRules(settings))}>Use these rules</button></div>
  </section></div>;
}
