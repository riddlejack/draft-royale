import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Swords } from "lucide-react";
import type { ArenaCard, ArenaView } from "@draft-royale/shared";

export function LoadingArena({ room, cards, onLoaded, onLeave }: { room: ArenaView; cards: ArenaCard[]; onLoaded: () => Promise<void>; onLeave: () => void }) {
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const action = useRef(onLoaded);
  action.current = onLoaded;
  const keys = [...room.board.map((cell) => cell.cardKey), ...room.participants.flatMap((player) => player.deck.map((entry) => entry.cardKey))].join(",");
  const urls = useMemo(() => {
    const board = new Set(keys.split(","));
    const relevant = room.settings.mode === "mega" ? cards.filter((card) => board.has(card.key)) : cards;
    return [...new Set(["/assets/placeholder-card.svg", ...relevant.flatMap((card) => card.forms.map((form) => form.asset))])];
  }, [cards, keys, room.settings.mode]);
  const loaded = room.participants.find((player) => player.seat === room.viewer)?.loaded;
  useEffect(() => {
    if (!cards.length || loaded) return;
    let disposed = false;
    let completed = 0;
    let cursor = 0;
    setFailed(false); setProgress(0);
    const preload = (src: string) => new Promise<void>((resolve, reject) => {
      const img = new Image();
      const timer = setTimeout(() => { img.onload = null; img.onerror = null; reject(new Error("Image timeout")); }, 30_000);
      img.onload = () => { clearTimeout(timer); resolve(); };
      img.onerror = () => { clearTimeout(timer); reject(new Error("Image unavailable")); };
      img.src = src;
    });
    const worker = async () => {
      while (cursor < urls.length && !disposed) {
        const url = urls[cursor++]!;
        await preload(url);
        completed += 1;
        if (!disposed) setProgress(completed / urls.length);
      }
    };
    void Promise.all([document.fonts.load("16px Supercell"), ...Array.from({ length: 6 }, worker)])
      .then(async () => { if (!disposed) await action.current(); })
      .catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; };
  }, [attempt, cards.length, loaded, urls]);
  return <div className="loading-scene room-scene">
    <header className="scene-toolbar"><button className="icon-button" onClick={onLeave} aria-label="Back to home"><ChevronLeft /></button><span>{room.settings.mirrorMode ? "Preparing the shared deck" : "Preparing the arena"}</span><Swords size={24} /></header>
    <div className="loading-stage-content"><div className="loading-card-fan" aria-hidden="true">{["knight", "pekka", "wizard"].map((key) => <img key={key} src={cards.find((card) => card.key === key)?.forms[0]?.asset} alt="" />)}</div>
      <h1>{failed ? "A little connection trouble" : loaded ? "Waiting for your rival" : "Getting your cards ready"}</h1>
      <p>{failed ? "Some artwork couldn't load. Try again when your connection is ready." : loaded ? "Your cards are ready. The draft starts when both players are loaded." : "The timer starts after both players are ready to play."}</p>
      <progress aria-label="Card artwork loading" value={loaded ? 1 : progress} max={1} />
      <div className="loading-player-status">{room.participants.map((player) => <span key={player.seat}>{player.loaded ? "✓" : "…"} {player.name}</span>)}</div>
      {failed && <button className="royale-button gold" onClick={() => setAttempt((value) => value + 1)}>Retry loading</button>}
    </div>
  </div>;
}
