import { useId, useMemo, useState } from "react";
import { Check, Search, X } from "lucide-react";
import { isFixedArenaElixirCost, isGroundArenaCard, isRangedArenaCard, type ArenaCard } from "@draft-royale/shared";
import { ArenaCardFace } from "./ArenaCardFace";
import "./CardPicker.css";

export interface CardPickerProps {
  cards: readonly ArenaCard[];
  selectedKeys: readonly string[];
  onSelectedKeysChange: (next: string[]) => void;
  maxSelected?: number;
  title?: string;
  selectionLabel?: string;
  disabledKeys?: readonly string[];
  compact?: boolean;
  showSelectedFirst?: boolean;
  /** Optional per-card record of the signed-in player, keyed by card key. Adds a badge and two sort options; the picker is unchanged without it. */
  cardStats?: ReadonlyMap<string, CardPickerStat>;
}

export interface CardPickerStat { games: number; winRate: number | null; badge: string; description: string; small: boolean }
export type PickerSort = "elixir" | "played" | "winRate";
export const PICKER_BADGE_MIN_GAMES = 3;
export const PICKER_RANKED_MIN_GAMES = 5;

export type PickerKind = "all" | "troop" | "building" | "spell";
export type PickerRole = "anti-air" | "flying" | "ground" | "ranged" | "special";

const kindLabels: Array<{ key: PickerKind; label: string }> = [
  { key: "all", label: "All" },
  { key: "troop", label: "Troops" },
  { key: "building", label: "Buildings" },
  { key: "spell", label: "Spells" },
];
const roleLabels: Array<{ key: PickerRole; label: string; title?: string }> = [
  { key: "anti-air", label: "Anti-air" },
  { key: "flying", label: "Flying" },
  { key: "ground", label: "Ground" },
  { key: "ranged", label: "Ranged", title: "Ranged troops, based on base-form attack range" },
  { key: "special", label: "Evos & Heroes" },
];
const rarityLabels = ["common", "rare", "epic", "legendary", "champion"] as const;

const matchesRole = (card: ArenaCard, role: PickerRole) => {
  if (role === "anti-air") return card.families.includes("anti-air");
  if (role === "flying") return card.families.includes("flying");
  if (role === "ground") return isGroundArenaCard(card);
  if (role === "ranged") return isRangedArenaCard(card);
  return card.forms.some((form) => form.key !== "base");
};

export function filterPickerCards(cards: readonly ArenaCard[], options: { search: string; kind: PickerKind; roles: ReadonlySet<PickerRole>; rarity: string; elixir: number | null }) {
  const search = options.search.trim().toLowerCase();
  return cards.filter((card) => (!search || card.name.toLowerCase().includes(search) || card.key.includes(search) || card.families.some((family) => family.includes(search)))
    && (options.kind === "all" || card.kind === options.kind)
    && (options.rarity === "all" || card.rarity === options.rarity)
    && (options.elixir === null || (isFixedArenaElixirCost(card.elixir) && card.elixir === options.elixir))
    && [...options.roles].every((role) => matchesRole(card, role)));
}

const byElixirThenName = (a: ArenaCard, b: ArenaCard) => (isFixedArenaElixirCost(a.elixir) ? a.elixir : Number.POSITIVE_INFINITY) - (isFixedArenaElixirCost(b.elixir) ? b.elixir : Number.POSITIVE_INFINITY) || a.name.localeCompare(b.name);

/** "played" puts the most-used cards first; "winRate" ranks only cards with enough games and leaves the rest in cost order after them. */
export function sortPickerCards(cards: readonly ArenaCard[], sort: PickerSort, stats?: ReadonlyMap<string, CardPickerStat>) {
  const games = (card: ArenaCard) => stats?.get(card.key)?.games ?? 0;
  const ranked = (card: ArenaCard) => games(card) >= PICKER_RANKED_MIN_GAMES && stats?.get(card.key)?.winRate !== null;
  return [...cards].sort((a, b) => sort === "played" ? games(b) - games(a) || byElixirThenName(a, b)
    : sort === "winRate" ? Number(ranked(b)) - Number(ranked(a)) || (ranked(a) && ranked(b) ? (stats!.get(b.key)!.winRate! - stats!.get(a.key)!.winRate!) || games(b) - games(a) : 0) || byElixirThenName(a, b)
      : byElixirThenName(a, b));
}

export function toggledPickerRoles(current: ReadonlySet<PickerRole>, role: PickerRole) {
  const next = new Set(current);
  if (next.has(role)) next.delete(role);
  else {
    next.add(role);
    if (role === "flying") next.delete("ground");
    if (role === "ground") next.delete("flying");
  }
  return next;
}

export function CardPicker({
  cards,
  selectedKeys,
  onSelectedKeysChange,
  maxSelected,
  title = "Choose cards",
  selectionLabel = "selected",
  disabledKeys = [],
  compact = false,
  showSelectedFirst = false,
  cardStats,
}: CardPickerProps) {
  const headingId = useId();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<PickerKind>("all");
  const [roles, setRoles] = useState<Set<PickerRole>>(() => new Set());
  const [rarity, setRarity] = useState("all");
  const [elixir, setElixir] = useState<number | null>(null);
  const [sort, setSort] = useState<PickerSort>("elixir");
  const hasStats = Boolean(cardStats?.size);
  const activeSort = hasStats ? sort : "elixir";
  const selected = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const disabled = useMemo(() => new Set(disabledKeys), [disabledKeys]);
  const visible = useMemo(() => {
    const sorted = sortPickerCards(filterPickerCards(cards, { search, kind, roles, rarity, elixir }), activeSort, cardStats);
    return showSelectedFirst ? sorted.sort((a, b) => Number(selected.has(b.key)) - Number(selected.has(a.key))) : sorted;
  }, [activeSort, cardStats, cards, elixir, kind, rarity, roles, search, selected, showSelectedFirst]);

  const toggle = (key: string) => {
    if (disabled.has(key)) return;
    if (selected.has(key)) {
      onSelectedKeysChange(selectedKeys.filter((candidate) => candidate !== key));
      return;
    }
    if (maxSelected !== undefined && selectedKeys.length >= maxSelected) return;
    onSelectedKeysChange([...selectedKeys, key]);
  };

  return <section className={`card-picker ${compact ? "is-compact" : ""}`} aria-labelledby={headingId}>
    <header className="card-picker-heading">
      <div><h3 id={headingId}>{title}</h3><span>{visible.length} shown · {selectedKeys.length}{maxSelected === undefined ? "" : ` / ${maxSelected}`} {selectionLabel}</span></div>
      {selectedKeys.length > 0 && <button type="button" className="card-picker-clear" onClick={() => onSelectedKeysChange([])}><X size={14} /> Clear</button>}
    </header>
    <label className="card-picker-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search cards…" aria-label="Search cards" />{search && <button type="button" onClick={() => setSearch("")} aria-label="Clear search"><X size={15} /></button>}</label>
    <div className="card-picker-filter-row">
      <div className="card-picker-filters card-picker-kind-filters" aria-label="Card type">
        {kindLabels.map((item) => <button type="button" key={item.key} className={kind === item.key ? "is-active" : ""} aria-pressed={kind === item.key} onClick={() => setKind(item.key)}>{item.label}</button>)}
      </div>
      <label className="card-picker-rarity">Rarity<select value={rarity} onChange={(event) => setRarity(event.target.value)}><option value="all">All</option>{rarityLabels.map((value) => <option value={value} key={value}>{value[0]?.toUpperCase()}{value.slice(1)}</option>)}</select></label>
    </div>
    {hasStats && <label className="card-picker-rarity card-picker-sort">Sort<select value={sort} onChange={(event) => setSort(event.target.value as PickerSort)}><option value="elixir">Elixir cost</option><option value="played">My most played</option><option value="winRate">My best win rate (min {PICKER_RANKED_MIN_GAMES} games)</option></select></label>}
    <div className="card-picker-filters card-picker-role-filters" aria-label="Card roles">
      {roleLabels.map((item) => <button type="button" key={item.key} title={item.title} className={roles.has(item.key) ? "is-active" : ""} aria-pressed={roles.has(item.key)} onClick={() => setRoles((current) => toggledPickerRoles(current, item.key))}>{item.label}</button>)}
    </div>
    <div className="card-picker-elixir" aria-label="Elixir cost filter">
      <button type="button" className={elixir === null ? "is-active" : ""} aria-pressed={elixir === null} onClick={() => setElixir(null)}>Any cost</button>
      {Array.from({ length: 10 }, (_, index) => index + 1).map((cost) => <button type="button" key={cost} className={elixir === cost ? "is-active" : ""} aria-pressed={elixir === cost} onClick={() => setElixir(elixir === cost ? null : cost)}>{cost}</button>)}
    </div>
    <div className="card-picker-grid">
      {visible.map((card) => {
        const isSelected = selected.has(card.key);
        const unavailable = disabled.has(card.key);
        const isDisabled = unavailable || (!isSelected && maxSelected !== undefined && selectedKeys.length >= maxSelected);
        const stat = cardStats?.get(card.key);
        const badge = stat && stat.games >= PICKER_BADGE_MIN_GAMES ? stat : null;
        return <button type="button" key={card.key} className={`card-picker-option ${isSelected ? "is-selected" : ""} ${unavailable ? "is-unavailable" : ""}`} disabled={isDisabled} aria-pressed={isSelected} aria-label={`${unavailable ? `${card.name} unavailable` : `${isSelected ? "Remove" : "Add"} ${card.name}`}${badge ? `. ${badge.description}` : ""}`} title={stat?.description} onClick={() => toggle(card.key)}>
          <ArenaCardFace card={card} form="base" legalForms={card.forms.map((form) => form.key)} />
          <span className="card-picker-name">{card.name}</span>
          {badge && <span className={`card-picker-stat${badge.small ? " is-small" : ""}`} aria-hidden="true">{badge.badge}</span>}
          {isSelected && <span className="card-picker-check"><Check size={13} strokeWidth={3} /></span>}
          {unavailable && <span className="card-picker-unavailable">Unavailable</span>}
        </button>;
      })}
      {visible.length === 0 && <p className="card-picker-empty">No cards match those filters.</p>}
    </div>
  </section>;
}
