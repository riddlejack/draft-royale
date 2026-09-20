import type { ArenaCard, ArenaEntry, ArenaParticipant, ArenaSeat } from "@draft-royale/shared";
import { ArenaCardFace } from "./ArenaCardFace";

interface DeckTrayProps {
  participant: ArenaParticipant;
  cardsByKey: ReadonlyMap<string, ArenaCard>;
  side: "opponent" | "viewer";
  concealCards?: boolean;
  hiddenSide?: "start" | "end";
  active?: boolean;
  seat: ArenaSeat;
}

interface TrayItem {
  entry?: ArenaEntry;
  occupied: boolean;
  concealed: boolean;
}

function TraySlot({
  entry,
  card,
  concealed,
  occupied,
  seat,
  index,
}: {
  entry?: ArenaEntry;
  card?: ArenaCard;
  concealed: boolean;
  occupied: boolean;
  seat: ArenaSeat;
  index: number;
}) {
  return (
    <span
      className={`arena-tray-slot ${occupied ? "is-filled" : ""}`}
      data-arena-tray-seat={seat}
      data-arena-tray-slot={index}
      data-arena-tray-card-key={entry?.cardKey}
      aria-hidden="true"
    >
      {occupied && concealed ? <span className="arena-card-back"><span /></span> : null}
      {entry && !concealed && card ? (
        <ArenaCardFace card={card} form={entry.form} className="arena-tray-card" />
      ) : null}
    </span>
  );
}

export function DeckTray({
  participant,
  cardsByKey,
  side,
  concealCards = false,
  hiddenSide = "end",
  active = false,
  seat,
}: DeckTrayProps) {
  const deckCount = Math.min(8, Math.max(participant.deckCount, participant.deck.length));
  const visibleEntries = concealCards ? [] : participant.deck.slice(0, deckCount);
  const hiddenCount = Math.max(0, deckCount - visibleEntries.length);
  const slots: TrayItem[] = Array.from({ length: 8 }, () => ({ occupied: false, concealed: false }));

  if (hiddenSide === "start" && hiddenCount > 0) {
    for (let index = 0; index < hiddenCount; index += 1) slots[index] = { occupied: true, concealed: true };
    const knownStart = 8 - visibleEntries.length;
    visibleEntries.forEach((entry, index) => {
      slots[knownStart + index] = { entry, occupied: true, concealed: false };
    });
  } else {
    visibleEntries.forEach((entry, index) => {
      slots[index] = { entry, occupied: true, concealed: false };
    });
    const hiddenStart = hiddenSide === "end" ? 8 - hiddenCount : visibleEntries.length;
    for (let index = 0; index < hiddenCount; index += 1) {
      slots[hiddenStart + index] = { occupied: true, concealed: true };
    }
  }

  return (
    <section className={`arena-tray is-${side} ${active ? "is-active" : ""}`} aria-label={`${participant.name}'s deck, ${participant.deckCount} of 8 cards`}>
      <div className="arena-tray-identity">
        <span className="arena-crown" aria-hidden="true">♛</span>
        <span className="arena-player-name">{participant.name}</span>
        <span className="arena-deck-count">{participant.deckCount}/8</span>
      </div>
      <div className="arena-tray-slots">
        {slots.map((slot, index) => (
          <TraySlot
            key={index}
            entry={slot.entry}
            card={slot.entry ? cardsByKey.get(slot.entry.cardKey) : undefined}
            concealed={slot.concealed || Boolean(slot.entry && !cardsByKey.has(slot.entry.cardKey))}
            occupied={slot.occupied}
            seat={seat}
            index={index}
          />
        ))}
      </div>
    </section>
  );
}
