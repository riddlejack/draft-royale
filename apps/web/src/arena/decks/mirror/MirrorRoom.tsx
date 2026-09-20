import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Copy, ExternalLink, Pencil, Shuffle, Users } from "lucide-react";
import type { ArenaCard, DeckDefinition, MirrorPlaylistKey, MirrorRoomCommand, MirrorRoomCredential, MirrorRoomView } from "@draft-royale/shared";
import { ArenaCardFace } from "../../components/ArenaCardFace";
import { DeckEditor } from "../DeckEditor";
import { clashDeckLink, deckElixirLabel } from "../deckUtils";
import { commandMirrorRoom, createMirrorRoom, getMirrorRoom, joinMirrorRoom, mirrorCommandId, MirrorRoomApiError, readMirrorCredential, writeMirrorCredential } from "./mirrorClient";
import "./mirror-room.css";

type PendingMirrorCommand =
  | { action: "next" | "previous" | "shuffle" }
  | { action: "edit"; deck: DeckDefinition }
  | { action: "playlist"; playlist: MirrorPlaylistKey };

interface MirrorRoomProps {
  catalog: readonly ArenaCard[];
  playerName: string;
  initialCode?: string;
  onBack: () => void;
  onCopy: (value: string, message: string) => void;
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : "Mirror room unavailable.";

export function MirrorRoom({ catalog, playerName, initialCode = "", onBack, onCopy }: MirrorRoomProps) {
  const [credential, setCredential] = useState<MirrorRoomCredential | null>(readMirrorCredential);
  const [room, setRoom] = useState<MirrorRoomView | null>(null);
  const [name, setName] = useState(playerName || "Player");
  const [code, setCode] = useState(initialCode);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<DeckDefinition | null>(null);
  const roomRef = useRef<MirrorRoomView | null>(null);
  const cardsByKey = useMemo(() => new Map(catalog.map((card) => [card.key, card])), [catalog]);
  roomRef.current = room;

  useEffect(() => {
    if (!credential) return;
    const abort = new AbortController();
    let busy = false;
    const refresh = async () => {
      if (busy || abort.signal.aborted) return;
      busy = true;
      try {
        const response = await getMirrorRoom(credential, abort.signal);
        setRoom((current) => !current || response.room.revision >= current.revision ? response.room : current);
      } catch (failure) {
        if (!abort.signal.aborted) setError(messageOf(failure));
      } finally { busy = false; }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 1200);
    return () => { abort.abort(); clearInterval(interval); };
  }, [credential]);

  const acceptSession = (session: { credential: MirrorRoomCredential; room: MirrorRoomView }) => {
    writeMirrorCredential(session.credential); setCredential(session.credential); setRoom(session.room); setError("");
  };
  const run = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true); setError("");
    try { await action(); } catch (failure) { setError(messageOf(failure)); }
    finally { setPending(false); }
  };
  const command = async (input: PendingMirrorCommand) => {
    if (!credential || !roomRef.current) return;
    const send = (expectedRevision: number) => commandMirrorRoom(credential, { ...input, expectedRevision, commandId: mirrorCommandId() } as MirrorRoomCommand);
    try {
      const response = await send(roomRef.current.revision);
      setRoom(response.room);
    } catch (failure) {
      const retryableConflict = input.action !== "edit" && failure instanceof MirrorRoomApiError && failure.status === 409 && failure.code === "REVISION_CONFLICT";
      if (!retryableConflict) throw failure;
      // A 409 guarantees the first command was not applied. Refresh and retry this
      // navigation once with a fresh operation id; edits always remain user-reviewed.
      const latest = await getMirrorRoom(credential);
      setRoom(latest.room);
      const retried = await send(latest.room.revision);
      setRoom(retried.room);
    }
  };
  const leave = () => { writeMirrorCredential(null); setCredential(null); setRoom(null); setEditing(null); };

  if (editing && room) return <DeckEditor catalog={catalog} initialDeck={editing} onBack={() => setEditing(null)} onCopy={onCopy} saveLabel="Update shared deck" onSave={async (deck) => {
    // Let DeckEditor own the pending/error state. A revision conflict stays visible in
    // the editor; polling refreshes roomRef so a deliberate second save uses the latest revision.
    await command({ action: "edit", deck });
    setEditing(null);
  }} />;

  if (!room) return <section className="mirror-room-entry">
    <header className="deck-workshop-toolbar"><button className="deck-back" onClick={onBack} aria-label="Back to decks"><ArrowLeft size={20} /></button><div><h1>Mirror Roulette</h1><span>One deck. Both players.</span></div><span /></header>
    <div className="mirror-entry-emblem"><img src="/assets/placeholder-card.svg" alt="Mirror" /><h2>Find a deck you both want to play.</h2><p>The host flips through a synchronized deck playlist. Both players always see the same current deck.</p></div>
    <label>Player name<input value={name} maxLength={24} onChange={(event) => setName(event.target.value)} /></label>
    <button className="mirror-primary" disabled={pending || !name.trim()} onClick={() => void run(async () => acceptSession(await createMirrorRoom(name.trim(), "mirror")))}><Users size={18} /> Start a Mirror room</button>
    <div className="mirror-join"><span>or join a friend</span><div><input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="ROOM CODE" maxLength={12} /><button disabled={pending || !name.trim() || !code.trim()} onClick={() => void run(async () => acceptSession(await joinMirrorRoom(name.trim(), code)))}>Join</button></div></div>
    {error && <p className="mirror-error" role="alert">{error}</p>}
  </section>;

  const deckLink = clashDeckLink(room.deck, cardsByKey);
  const inviteUrl = `${window.location.origin}${window.location.pathname}?mirror=${encodeURIComponent(room.code)}#decks`;

  return <section className="mirror-room-screen">
    <header className="deck-workshop-toolbar"><button className="deck-back" onClick={onBack} aria-label="Back to decks"><ArrowLeft size={20} /></button><div><h1>Mirror Roulette</h1><span>{room.guestName ? `${room.hostName} + ${room.guestName}` : "Waiting for teammate"}</span></div><button className="mirror-leave" onClick={leave}>Leave</button></header>
    <section className="mirror-invite"><div><span>Room code</span><strong>{room.code}</strong></div><button onClick={() => onCopy(inviteUrl, "Mirror room invite copied.")}><Copy size={15} /> Invite friend</button></section>
    <nav className="mirror-playlists" aria-label="Mirror playlists">{room.availablePlaylists.map((playlist) => <button key={playlist.id} disabled={!room.canEdit || pending} className={playlist.id === room.playlist ? "is-active" : ""} onClick={() => void run(() => command({ action: "playlist", playlist: playlist.id }))}><strong>{playlist.label}</strong><span>{playlist.count} decks</span></button>)}</nav>
    <section className="mirror-current-deck">
      <header><div><span>{room.index < 0 ? "Custom room remix" : room.playlist === "mirror" ? "Generated Mirror remix" : room.playlist === "classics" ? room.deck.source.kind === "supercell" ? "Historical official classic" : "Classic library deck" : "Community deck"}</span><h2>{room.deck.name}</h2><p>{room.deck.description ?? room.deck.source.label}</p></div><b>{room.index >= 0 ? `${room.index + 1} / ${room.playlistCount}` : "Edited"}</b></header>
      <div className="mirror-deck-grid">{room.deck.cards.map((key) => { const card = cardsByKey.get(key); const form = room.deck.forms?.[key] ?? "base"; return card ? <div key={key} title={card.forms.find((candidate) => candidate.key === form)?.label ?? card.name}><ArenaCardFace card={card} form={form} /><strong>{card.name}</strong></div> : null; })}</div>
      <div className="mirror-deck-meta"><span>{deckElixirLabel(room.deck, catalog)}</span><span>Source: {room.deck.source.label}</span></div>
      {room.canEdit && <div className="mirror-control-deck"><button disabled={pending || !room.canGoPrevious} onClick={() => void run(() => command({ action: "previous" }))}><ChevronLeft size={19} /> Previous</button><button disabled={pending} onClick={() => void run(() => command({ action: "shuffle" }))}><Shuffle size={18} /> Shuffle</button><button disabled={pending} onClick={() => void run(() => command({ action: "next" }))}>Next <ChevronRight size={19} /></button></div>}
      {!room.canEdit && <p className="mirror-following">The host controls the playlist. This deck updates here for both players.</p>}
      <div className="mirror-deck-actions"><button disabled={!deckLink} onClick={() => onCopy(deckLink, "Mirror deck link copied.")}><Copy size={16} /> Copy deck</button>{deckLink && <a href={deckLink} target="_blank" rel="noreferrer">Open in Clash <ExternalLink size={15} /></a>}{room.canEdit && <button onClick={() => setEditing(room.deck)}><Pencil size={15} /> Edit together</button>}</div>
    </section>
    <p className="mirror-room-note">Both players import this deck and choose the same tower troop. Clash Royale controls the in-game starting hand, so this companion cannot guarantee identical opening cards.</p>
    {error && <p className="mirror-error" role="alert">{error}</p>}
  </section>;
}
