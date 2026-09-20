import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Check, ChevronLeft, Copy, Crown, Link, Settings2, Shield, Swords, Users, Volume2, VolumeX, WifiOff } from "lucide-react";
import { ARENA_MEGA_MAX_POOL_SIZE, DEFAULT_ARENA_SETTINGS, isChaosBattleMode, shouldPresetMirrorCard, arenaElixirRanges, type ArenaCatalogResponse, type ArenaCollection, type ArenaCredential, type ArenaMode, type ArenaSessionResponse, type ArenaSettings, type ArenaView } from "@draft-royale/shared";
import { ArenaApiError, createArenaRoom, forgetCredential, getArenaCatalog, joinArenaRoom, loadArenaRoom, loadRoomCatalog, saveCredential, sendArenaCommand, storage } from "./client";
import { ALL_CARDS, CollectionEditor } from "./CollectionEditor";
import { SettingsEditor } from "./SettingsEditor";
import { LoadingArena } from "./LoadingArena";
import { DraftStage } from "./DraftStage";
import { SocialPanel } from "./SocialPanel";
import { useSocial } from "./useSocial";
import { DeckLibrary } from "./decks/DeckLibrary";
import { MirrorRoom } from "./decks/mirror/MirrorRoom";
import { StatsBoard } from "./tracker/StatsBoard";
import "./workshop-nav.css";
import { AccountButton, AccountControl } from "./accounts/AccountControl";
import "./arena.css";

const modes: { key: ArenaMode; title: string; description: string; cards: string[] }[] = [
  { key: "mega", title: "Mega Draft", description: "One shared board. Every pick matters.", cards: ["knight", "pekka", "wizard"] },
  { key: "triple", title: "Triple Draft", description: "Three choices. Your perfect eight.", cards: ["hog-rider", "baby-dragon", "goblin-barrel"] },
  { key: "classic", title: "Classic Draft", description: "Keep one. Give your rival the other.", cards: ["prince", "dark-prince"] },
];
const modeName = (mode: ArenaMode) => modes.find((item) => item.key === mode)?.title ?? "Mega Draft";
const rulesSummary = (value: ArenaSettings) => `${value.mode === "mega" ? `Up to ${value.poolSize} cards · ` : ""}${arenaElixirRanges(value).length ? `${arenaElixirRanges(value).map(({ min, max }) => `${min}–${max}`).join(" or ")} elixir · ` : ""}${value.pickSeconds}s ${value.timerMode === "whole_draft" ? "total" : "per pick"} · ${value.specialForms ? "Evos, Heroes & Champions" : "Classic cards"}${value.mode === "triple" && value.specialForms && value.groupedSpecialRounds ? " · Grouped special rounds" : ""}${isChaosBattleMode(value.battleMode) ? " · Chaos pool" : ""}${value.mirrorMode ? " · Mirror decks" : ""}`;
const messageOf = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please try again.";
const streamingEnabled = import.meta.env.VITE_ARENA_TRANSPORT !== "polling";
type AppSurface = "home" | "decks" | "mirror" | "stats";
const surfaceFromLocation = (): AppSurface => {
  const url = new URL(window.location.href);
  if (url.hash === "#mirror" || url.searchParams.has("mirror")) return "mirror";
  if (url.hash === "#stats") return "stats";
  return url.hash === "#decks" || url.searchParams.has("deck") || url.searchParams.has("pair") ? "decks" : "home";
};

export function ArenaApp() {
  const [catalog, setCatalog] = useState<ArenaCatalogResponse | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [roomCatalog, setRoomCatalog] = useState<{ roomId: string; data: ArenaCatalogResponse } | null>(null);
  const [roomCatalogFailed, setRoomCatalogFailed] = useState(false);
  const activeCredential = useRef<ArenaCredential | null>(null);
  const activeOperation = useRef(0);
  const [name, setName] = useState(() => storage.get("name", "Player"));
  const [settings, setSettings] = useState<ArenaSettings>(() => {
    const saved = storage.get<Partial<ArenaSettings>>("settings", {});
    const nativePrivate = saved.mode !== undefined && saved.mode !== "mega";
    return { ...DEFAULT_ARENA_SETTINGS, ...saved, poolSize: Math.min(saved.poolSize ?? DEFAULT_ARENA_SETTINGS.poolSize, ARENA_MEGA_MAX_POOL_SIZE), timerMode: saved.timerMode ?? (nativePrivate ? "whole_draft" : "per_pick"), pickSeconds: nativePrivate && !saved.timerMode ? 60 : saved.pickSeconds ?? 15 };
  });
  const [collection, setCollection] = useState<ArenaCollection>(() => storage.get("collection", ALL_CARDS));
  const [credential, setCredential] = useState<ArenaCredential | null>(null);
  const [room, setRoom] = useState<ArenaView | null>(null);
  const roomRef = useRef<ArenaView | null>(null);
  const navigationEpoch = useRef(0);
  const suppressedAutoInvites = useRef(new Set<string>());
  const observedDraftEpoch = useRef<string | null>(null);
  const [finishedEpoch, setFinishedEpoch] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<"rules" | "collection" | "join" | "social" | null>(null);
  const [invite, setInvite] = useState("");
  const [friendToken, setFriendToken] = useState("");
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");
  const [sound, setSound] = useState(() => storage.get("sound", false));
  const [surface, setSurface] = useState<AppSurface>(surfaceFromLocation);
  const social = useSocial(name);
  const goTo = (next: AppSurface) => {
    navigationEpoch.current += 1;
    const url = new URL(window.location.href);
    for (const key of ["deck", "pair", "mirror"]) url.searchParams.delete(key);
    url.hash = next === "home" ? "" : next;
    window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setSurface(next); window.scrollTo(0, 0);
  };
  const cards = room ? roomCatalog?.roomId === room.id ? roomCatalog.data.cards : [] : catalog?.cards ?? [];
  const cardsByKey = useMemo(() => new Map(cards.map((card) => [card.key, card])), [cards]);
  const savedRooms = storage.get<ArenaCredential[]>("rooms", []);
  const draftEpoch = room ? `${room.id}:${room.startedAt}` : null;
  const finishingDraft = room?.phase === "complete" && observedDraftEpoch.current === draftEpoch && finishedEpoch !== draftEpoch;
  roomRef.current = room;

  useEffect(() => {
    if (room?.phase === "drafting") {
      observedDraftEpoch.current = draftEpoch;
      return;
    }
    if (room?.phase !== "complete" || observedDraftEpoch.current !== draftEpoch) return;
    // Keep the accepted final revision on stage long enough for its card flight.
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 800;
    const timer = setTimeout(() => setFinishedEpoch(draftEpoch), delay);
    return () => clearTimeout(timer);
  }, [draftEpoch, room?.phase]);

  const acceptRoom = useCallback((next: ArenaView) => {
    if (activeCredential.current?.roomId !== next.id || activeCredential.current.seat !== next.viewer) return;
    setRoom((previous) => !previous || previous.id !== next.id || next.revision >= previous.revision ? next : previous);
  }, []);
  const openSession = useCallback((response: ArenaSessionResponse) => {
    navigationEpoch.current += 1;
    activeCredential.current = response.credential;
    saveCredential(response.credential); setCredential(response.credential); setRoom(response.room);
    setModal(null); setError(""); window.history.replaceState(null, "", `#room=${encodeURIComponent(response.room.id)}`);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const handleInviteHash = () => {
      const query = new URLSearchParams(window.location.hash.slice(1));
      const code = query.get("join");
      const sharedFriendToken = query.get("friend");
      const draftIsActive = roomRef.current?.phase === "loading" || roomRef.current?.phase === "drafting";
      if (sharedFriendToken) {
        setFriendToken(sharedFriendToken);
        if (!draftIsActive) { navigationEpoch.current += 1; setModal("social"); }
      } else if (code) {
        setInvite(code);
        if (!draftIsActive) { navigationEpoch.current += 1; setModal("join"); }
      }
    };
    handleInviteHash();
    window.addEventListener("hashchange", handleInviteHash);

    const query = new URLSearchParams(window.location.hash.slice(1));
    const id = query.get("room");
    const saved = storage.get<ArenaCredential[]>("rooms", []).find((item) => item.roomId === id);
    if (saved) {
      const expectedNavigation = ++navigationEpoch.current;
      setPending(true);
      void loadArenaRoom(saved).then((next) => { if (!cancelled && navigationEpoch.current === expectedNavigation) { setPending(false); openSession({ room: next, credential: saved }); } }).catch((failure) => { if (!cancelled && navigationEpoch.current === expectedNavigation) {
        if (failure instanceof ArenaApiError && ([401,404,410].includes(failure.status) || failure.code === "INVALID_ROOM_STATE")) {
          forgetCredential(saved.roomId); window.history.replaceState(null, "", window.location.pathname); setNotice("That older draft is no longer available. Start a fresh draft.");
        } else setError(messageOf(failure));
      } }).finally(() => { if (!cancelled && navigationEpoch.current === expectedNavigation) setPending(false); });
    }
    return () => { cancelled = true; window.removeEventListener("hashchange", handleInviteHash); };
  }, [openSession]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let failures = 0;
    const load = async () => {
      if (busy || disposed) return;
      busy = true; clearTimeout(timer);
      try { const next = await getArenaCatalog(); if (!disposed) { setCatalog(next); setCatalogFailed(false); } }
      catch { if (!disposed) { setCatalogFailed(true); timer = setTimeout(() => void load(), Math.min(8000, 1000 * 2 ** failures++)); } }
      finally { busy = false; }
    };
    const online = () => void load();
    void load(); window.addEventListener("online", online);
    return () => { disposed = true; clearTimeout(timer); window.removeEventListener("online", online); };
  }, [catalogRetry]);

  useEffect(() => {
    if (!credential) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let failures = 0;
    setRoomCatalogFailed(false);
    const load = async () => {
      if (busy || disposed) return;
      busy = true; clearTimeout(timer);
      try { const data = await loadRoomCatalog(credential); if (!disposed && activeCredential.current?.token === credential.token) { setRoomCatalog({ roomId: credential.roomId, data }); setRoomCatalogFailed(false); } }
      catch { if (!disposed) { setRoomCatalogFailed(true); timer = setTimeout(() => void load(), Math.min(8000, 1000 * 2 ** failures++)); } }
      finally { busy = false; }
    };
    const online = () => void load();
    void load(); window.addEventListener("online", online);
    return () => { disposed = true; clearTimeout(timer); window.removeEventListener("online", online); };
  }, [credential, catalogRetry]);

  useEffect(() => {
    if (!credential) return;
    let disposed = false;
    setConnection("connecting");
    const abort = new AbortController();
    let streamLive = false;
    let pollBusy = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const response = await fetch(`/api/arena/rooms/${encodeURIComponent(credential.roomId)}/events`, {
          headers: { Authorization: `Bearer ${credential.token}`, Accept: "text/event-stream" },
          signal: abort.signal,
        });
        if (!response.ok || !response.body) throw new Error("Stream unavailable");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!disposed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const packet = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = packet.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            const next = JSON.parse(data) as ArenaView;
            if (!disposed && next.id === credential.roomId) { acceptRoom(next); streamLive = true; setConnection("live"); }
          }
        }
      } catch { /* Authenticated polling keeps rooms live when a host cannot stream. */ }
      finally { streamLive = false; if (!disposed) retryTimer = setTimeout(() => void connect(), 4000); }
    };
    if (streamingEnabled) void connect();
    const refresh = async () => {
      if (pollBusy || disposed) return;
      pollBusy = true;
      try {
        const next = await loadArenaRoom(credential);
        if (!disposed) { acceptRoom(next); setConnection("live"); }
      } catch (failure) {
        if (!disposed) {
          setConnection("offline");
          if (failure instanceof ArenaApiError && (failure.status === 401 || failure.status === 404)) setError(failure.message);
        }
      } finally { pollBusy = false; }
    };
    let ticks = 0;
    const interval = window.setInterval(() => { ticks += 1; if (!streamLive || ticks % 7 === 0) void refresh(); }, 1000);
    const wake = () => { if (document.visibilityState === "visible") void refresh(); };
    const online = () => void refresh();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", online);
    return () => { disposed = true; abort.abort(); clearTimeout(retryTimer); clearInterval(interval); document.removeEventListener("visibilitychange", wake); window.removeEventListener("online", online); };

  }, [credential, acceptRoom]);

  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 3500); return () => clearTimeout(timer); }, [notice]);

  useEffect(() => {
    const syncSurface = () => {
      if (roomRef.current) return;
      setSurface(surfaceFromLocation());
    };
    window.addEventListener("hashchange", syncSurface);
    window.addEventListener("popstate", syncSurface);
    return () => { window.removeEventListener("hashchange", syncSurface); window.removeEventListener("popstate", syncSurface); };
  }, []);

  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = document.querySelector<HTMLElement>(".arena-modal");
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]') ?? []);
    focusables()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (modal === "social") { navigationEpoch.current += 1; if (friendToken) { setFriendToken(""); window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`); } }
        if (modal === "join") navigationEpoch.current += 1;
        setModal(null);
      }
      if (event.key !== "Tab") return;
      const items = focusables(); const first = items[0]; const last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [friendToken, modal]);

  async function run(action: () => Promise<void>) {
    if (pendingRef.current) return false;
    const operation = ++activeOperation.current;
    pendingRef.current = true; setPending(true); setError("");
    try { await action(); return true; } catch (failure) {
      if (activeOperation.current === operation) {
        setError(messageOf(failure));
        const current = activeCredential.current;
        if (current) void loadArenaRoom(current).then(acceptRoom).catch(() => undefined);
      }
      return false;
    } finally { if (activeOperation.current === operation) { pendingRef.current = false; setPending(false); } }
  }
  async function start(practice: boolean) {
    const expectedNavigation = ++navigationEpoch.current;
    storage.set("name", name.trim() || "Player"); storage.set("settings", settings);
    await run(async () => {
      const session = await createArenaRoom({ name: name.trim() || "Player", settings, collection, practice });
      if (navigationEpoch.current !== expectedNavigation) return;
      openSession(session);
      if (practice) acceptRoom(await sendArenaCommand(session.credential, "ready", { ready: true }));
    });
  }
  async function command(action: string, body: Record<string, unknown> = {}) {
    const current = activeCredential.current;
    if (!current) throw new Error("This draft is no longer open.");
    const next = await sendArenaCommand(current, action, body);
    if (activeCredential.current?.token === current.token) acceptRoom(next);
  }
  async function copy(text: string, success: string) {
    try { await navigator.clipboard.writeText(text); setNotice(success); }
    catch { setNotice("Copy is unavailable in this browser. Press and hold the link to copy it."); }
  }
  const markSocialInviteOpened = useCallback((inviteId: string) => {
    const opened = storage.get<string[]>("social-opened-invites", []);
    if (!opened.includes(inviteId)) storage.set("social-opened-invites", [...opened.slice(-39), inviteId]);
  }, []);
  const openSocialSession = useCallback((response: ArenaSessionResponse, inviteId: string) => {
    markSocialInviteOpened(inviteId);
    openSession(response);
  }, [markSocialInviteOpened, openSession]);
  const closeSocial = useCallback(() => {
    navigationEpoch.current += 1;
    setModal(null);
    setFriendToken("");
    const query = new URLSearchParams(window.location.hash.slice(1));
    if (query.has("friend")) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }, []);

  const openSocialInvite = useCallback(async (inviteId: string, accept: boolean) => {
    const expectedNavigation = ++navigationEpoch.current;
    const credentialAtStart = activeCredential.current?.token ?? null;
    const roomAtStart = roomRef.current ? `${roomRef.current.id}:${roomRef.current.phase}` : null;
    const session = accept ? await social.acceptInvite(inviteId, collection) : await social.openInvite(inviteId);
    const currentRoom = roomRef.current;
    const currentRoomState = currentRoom ? `${currentRoom.id}:${currentRoom.phase}` : null;
    if (!session || navigationEpoch.current !== expectedNavigation || (activeCredential.current?.token ?? null) !== credentialAtStart || currentRoomState !== roomAtStart || currentRoom?.phase === "loading" || currentRoom?.phase === "drafting") return;
    openSocialSession(session, inviteId);
  }, [collection, openSocialSession, social.acceptInvite, social.openInvite]);

  const openedSocialInvites = storage.get<string[]>("social-opened-invites", []);
  const acceptedOutgoingIds = social.state?.outgoingInvites.filter((item) => item.status === "accepted" && !openedSocialInvites.includes(item.id)).map((item) => item.id) ?? [];
  const acceptedOutgoingKey = acceptedOutgoingIds.join("|");
  const socialSessionBusy = [...(social.state?.incomingInvites ?? []), ...(social.state?.outgoingInvites ?? [])].some((item) => ["accept", "open"].some((action) => social.isPending(`invite:${action}:${item.id}`)));
  const socialServerNow = social.state?.serverNow;
  const previousRoomForAuto = useRef<ArenaView | null>(null);
  const attemptedAutoObservation = useRef("");
  useEffect(() => {
    const hadRoom = previousRoomForAuto.current !== null;
    previousRoomForAuto.current = room;
    if (room || hadRoom) {
      for (const inviteId of acceptedOutgoingIds) suppressedAutoInvites.current.add(inviteId);
      return;
    }
    if (surface !== "home" || pending || (modal !== null && modal !== "social") || friendToken || socialSessionBusy || acceptedOutgoingIds.length === 0) return;
    const inviteId = acceptedOutgoingIds.find((id) => !suppressedAutoInvites.current.has(id));
    if (!inviteId) return;
    const observation = `${inviteId}:${socialServerNow ?? "unknown"}`;
    if (attemptedAutoObservation.current === observation) return;
    attemptedAutoObservation.current = observation;
    const expectedNavigation = navigationEpoch.current;
    void social.openInvite(inviteId, true).then((session) => {
      if (session && navigationEpoch.current === expectedNavigation && !activeCredential.current && !roomRef.current) openSocialSession(session, inviteId);
    });
  }, [acceptedOutgoingKey, friendToken, modal, openSocialSession, pending, room, social.openInvite, socialServerNow, socialSessionBusy, surface]);

  const leave = () => {
    navigationEpoch.current += 1; observedDraftEpoch.current = null; activeCredential.current = null; activeOperation.current += 1; pendingRef.current = false;
    setPending(false); setRoomCatalog(null); setRoom(null); setCredential(null); setError("");
    const query = new URLSearchParams(window.location.hash.slice(1));
    if (query.has("friend")) { setFriendToken(query.get("friend") ?? ""); setModal("social"); }
    else if (query.has("join")) { setInvite(query.get("join") ?? ""); setModal("join"); }
    else window.history.replaceState(null, "", window.location.pathname);
  };
  const ready = room?.participants.find((participant) => participant.seat === room.viewer)?.ready ?? false;
  const practice = room?.participants.some((participant) => participant.bot) ?? false;
  const roomExportError = room && "exportError" in room && typeof room.exportError === "string" ? room.exportError : null;
  const socialBadge = social.state?.incomingInvites.filter((item) => item.status === "pending").length ?? 0;
  const socialButton = <button className="icon-button social-toolbar-button" aria-label={socialBadge > 0 ? `Friends and invitations, ${socialBadge} new` : "Friends and invitations"} onClick={() => { setFriendToken(""); setModal("social"); }}><Users size={19} />{socialBadge > 0 && <span className="social-toolbar-badge">{socialBadge}</span>}</button>;

  return <main className={`arena-app ${room?.phase === "drafting" ? "is-drafting" : ""}`}>
    {!room && surface === "home" && <div className="home-scene">
      <header className="home-toolbar"><button className="icon-button" aria-label={sound ? "Turn sound off" : "Turn sound on"} onClick={() => { setSound(!sound); storage.set("sound", !sound); }}>{sound ? <Volume2 size={21} /> : <VolumeX size={21} />}</button><div className="scene-toolbar-actions"><AccountButton />{socialButton}<button className="small-button" onClick={() => setModal("collection")}><Shield size={16} /> My cards</button></div></header>
      <div className="royale-brand"><Crown className="brand-crown" size={50} strokeWidth={2.5} /><h1><span>DRAFT</span><span>ROYALE</span></h1><p>Your rules. Your rival. Your battle.</p></div>
      <div className="home-content">
        <nav className="home-feature-nav" aria-label="Play and build"><button onClick={() => goTo("decks")}>Deck library</button><button onClick={() => goTo("mirror")}>Mirror roulette</button><button onClick={() => goTo("stats")}>Match records</button></nav>
        <div className="mode-picker" role="group" aria-label="Draft mode">{modes.map((mode) => <button key={mode.key} className={`mode-card ${settings.mode === mode.key ? "selected" : ""}`} aria-pressed={settings.mode === mode.key} onClick={() => { const next: ArenaSettings = { ...settings, mode: mode.key, timerMode: mode.key === "mega" ? "per_pick" : "whole_draft", pickSeconds: mode.key === "mega" ? 15 : 60, groupedSpecialRounds: mode.key === "triple" ? settings.groupedSpecialRounds : false }; setSettings(next); storage.set("settings", next); }}>
          <div className="mode-art" aria-hidden="true">{mode.cards.map((key, index) => <img src={cardsByKey.get(key)?.forms[0]?.asset ?? `/assets/placeholder-card.svg`} key={key} alt="" style={{ "--fan-index": index, "--fan-total": mode.cards.length } as React.CSSProperties} />)}</div>
          <div className="mode-copy"><strong>{mode.title}</strong><span>{mode.description}</span></div>{settings.mode === mode.key && <span className="mode-selected"><Check size={16} /></span>}
        </button>)}</div>
        <button className="rules-summary" onClick={() => setModal("rules")}><Settings2 size={17} /><span>{rulesSummary(settings)}</span><span>›</span></button>
        <label className="name-field"><span>Your name</span><input maxLength={24} value={name} autoComplete="nickname" onChange={(event) => { setName(event.target.value); storage.set("name", event.target.value); }} /></label>
        <div className="home-actions"><button className="royale-button deck-workshop-entry" disabled={!catalog} onClick={() => { setSurface("decks"); window.history.pushState(null, "", `${window.location.pathname}${window.location.search}#decks`); }}><BookOpen size={21} /> Deck Workshop <span>Build, save & share decks</span></button><button className="royale-button gold" disabled={pending || !catalog} onClick={() => { setFriendToken(""); setModal("social"); }}><Swords size={21} /> Challenge a friend</button><button className="royale-button blue" disabled={pending || !catalog} onClick={() => void start(true)}>Practice draft <span>Play against a bot</span></button></div>
        <div className="home-links"><button disabled={pending || !catalog} onClick={() => void start(false)}><Link size={15} /> Invite by link</button><button onClick={() => setModal("join")}>Join with a code</button>{savedRooms[0] && <button disabled={pending} onClick={() => { const expectedNavigation = ++navigationEpoch.current; void run(async () => { const saved = savedRooms[0]!; const next = await loadArenaRoom(saved); if (navigationEpoch.current === expectedNavigation) openSession({ room: next, credential: saved }); }); }}>Resume draft</button>}</div>
      </div>
      <footer className="home-footer">Draft here. Play in Clash Royale.<small>Independent fan-made companion</small></footer>
    </div>}

    {!room && surface === "decks" && catalog && <DeckLibrary catalog={catalog.cards} credential={social.identity} onBack={() => goTo("home")} onMirror={() => goTo("mirror")} onCopy={(value, message) => void copy(value, message)} />}
    {!room && surface === "mirror" && catalog && <MirrorRoom catalog={catalog.cards} playerName={name} initialCode={new URL(window.location.href).searchParams.get("mirror") ?? ""} onBack={() => goTo("home")} onCopy={(value, message) => void copy(value, message)} />}
    {!room && surface === "stats" && <section className="stats-scene"><header className="scene-toolbar"><button className="icon-button" aria-label="Back to home" onClick={() => goTo("home")}><ChevronLeft /></button><span>Match records</span><AccountButton /></header><StatsBoard credential={social.identity} onSignIn={() => window.dispatchEvent(new Event("draft-royale:sign-in"))} /></section>}

    {room?.phase === "waiting" && <div className="room-scene">
      <header className="scene-toolbar"><button className="icon-button" onClick={leave} aria-label="Back to home"><ChevronLeft /></button><span>{modeName(room.settings.mode)}</span><div className="scene-toolbar-actions">{socialButton}<button className="icon-button" aria-label="My cards" onClick={() => setModal("collection")}><Shield size={21} /></button></div></header>
      <div className="lobby-emblem"><Swords size={66} /><h1>Battle room</h1><p>{room.settings.mirrorMode ? shouldPresetMirrorCard(room.settings) ? "Mirror starts in both decks. Take turns drafting seven more cards." : "Take turns choosing one deck for both players." : practice ? "Your practice rival is ready." : "Bring your rival. Settle it in the arena."}</p></div>
      <div className="lobby-players">{(["a", "b"] as const).map((seat) => { const person = room.participants.find((participant) => participant.seat === seat); return <div key={seat} className={`lobby-player ${seat === room.viewer ? "you" : "opponent"}`}><div className="player-shield"><Crown size={29} /></div><strong>{person?.name ?? "Waiting for a friend…"}</strong><span>{person ? person.ready ? "Ready!" : "Getting ready" : "Share the invite below"}</span>{person?.ready && <Check className="ready-check" />}</div>; })}<span className="versus">VS</span></div>
      {!practice && <div className="invite-panel"><span>Room code</span><strong>{room.inviteCode}</strong><button className="royale-button blue" onClick={() => void copy(`${window.location.origin}${window.location.pathname}#join=${encodeURIComponent(room.inviteCode)}`, "Invite copied. Send it to your friend.")}><Copy size={17} /> Copy invite link</button><a className="plain-invite" href={`#join=${room.inviteCode}`} onClick={(event) => event.preventDefault()}>{`${window.location.origin}/#join=${room.inviteCode}`}</a></div>}
      <button className="rules-summary" disabled={room.viewer !== "a"} onClick={() => { setSettings(room.settings); setModal("rules"); }}><Settings2 size={17} /><span>{rulesSummary(room.settings)}</span>{room.viewer === "a" && <span>›</span>}</button>
      <p className="lobby-collection">Your collection: {collection.source === "unrestricted" ? "all cards and forms" : "your saved selection"} <button onClick={() => setModal("collection")}>Edit</button></p>
      <button className={`royale-button ${ready ? "blue" : "gold"} full-width`} disabled={pending} onClick={() => void run(() => command("ready", { ready: !ready }))}>{ready ? "Ready — waiting for rival" : "I'm ready"}</button>
    </div>}

    {room?.phase === "loading" && <LoadingArena room={room} cards={cards} onLeave={leave} onLoaded={() => command("loaded")} />}

    {room && (room.phase === "drafting" || finishingDraft) && cards.length > 0 && <DraftStage room={room} cards={cards} pending={pending} soundEnabled={sound} onLeave={leave} onPick={async (cardKey, form) => { const accepted = await run(() => command("pick", { cardKey, form, expectedRevision: room.revision })); if (!accepted) throw new Error("Pick was not accepted"); }} />}

    {room?.phase === "complete" && !finishingDraft && cards.length > 0 && <div className="finish-scene">
      <header className="scene-toolbar"><button className="icon-button" onClick={leave} aria-label="Back to home"><ChevronLeft /></button><span>{modeName(room.settings.mode)}</span><div className="scene-toolbar-actions">{socialButton}<Crown size={23} /></div></header>
      <div className={`finish-heading ${room.export ? "" : "export-failed"}`}><div className="victory-shield">{room.export ? <Check size={46} /> : <Swords size={40} />}</div><h1>{room.export ? room.settings.mirrorMode ? "Mirror deck ready!" : "Deck ready!" : "Draft again"}</h1><p>{room.export ? room.settings.mirrorMode ? "Both players have this exact deck." : "Take your picks into the arena." : roomExportError ?? "This completed draft cannot make a valid Clash Royale deck link."}</p></div>
      <div className="finished-deck">{(room.export?.entries ?? room.participants.find((participant) => participant.seat === room.viewer)?.deck ?? []).map((entry, index) => { const card = cardsByKey.get(entry.cardKey); const form = card?.forms.find((item) => item.key === entry.form) ?? card?.forms[0]; return <div className={`finished-card ${entry.form}`} key={entry.cardKey}><img src={form?.asset} alt={`${card?.name ?? entry.cardKey}${entry.form === "base" ? "" : ` ${entry.form}`}`} /><span>{entry.form === "base" ? entry.preset ? "Included" : "" : index === 2 ? `Wild · ${entry.form === "evolution" ? "Evo" : entry.form === "hero" ? "Hero" : "Champion"}` : entry.form === "evolution" ? "Evolution slot" : "Hero slot"}</span></div>; })}</div>
      <div className="deck-detail"><span>Average elixir <b>{room.export?.averageElixir?.toFixed(1) ?? "—"}</b><i>●</i></span><span>8 / 8 cards</span></div>
      {room.export && <div className="export-actions"><a className="royale-button gold full-width" href={room.export.url}>Open in Clash Royale <span>Import your drafted deck</span></a><button className="small-button" onClick={() => void copy(room.export!.url, "Deck link copied.")}><Copy size={16} /> Copy deck link</button></div>}
      {room.export && <div className="handoff-instructions"><h2>One last step</h2><p>Choose a deck slot when Clash Royale opens. {room.export.entries.some((entry) => entry.form !== "base") ? "Check that the marked Evolutions, Heroes, and Champions are active in their indicated special slots." : "Check your tower troop before you battle."}</p><p>{room.settings.mirrorMode ? "Both players should import this deck, then start " : "Start "}<strong>{room.settings.battleMode}</strong>{room.settings.mirrorMode ? " together. Choose the same tower troop in Clash Royale, too." : " with your friend using this deck."}</p></div>}
      <button className="royale-button blue full-width" disabled={pending} onClick={() => void run(async () => { await command("rematch"); if (practice) await command("ready", { ready: true }); })}>Draft again</button><button className="text-button" onClick={leave}>Back to home</button>
    </div>}

    {room && cards.length === 0 && room.phase !== "waiting" && room.phase !== "loading" && <div className="room-scene sync-scene"><button className="icon-button" onClick={leave} aria-label="Back to home"><ChevronLeft /></button><h1>Rejoining the arena…</h1><p>Getting the saved cards for this draft.</p></div>}
    {(room ? roomCatalogFailed : catalogFailed) && <div className="catalog-retry" role="alert"><span>Card data couldn't load. Reconnecting…</span><button className="small-button" onClick={() => setCatalogRetry((value) => value + 1)}>Retry now</button></div>}
    {room && connection === "offline" && <div className="connection-banner" role="status"><WifiOff size={15} /> Reconnecting… your draft is saved.</div>}
    {pending && !room && <div className="loading-banner" role="status">Opening the arena…</div>}
    {error && <div className="error-toast" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}
    {notice && <div className="notice-toast" role="status">{notice}</div>}
    {modal === "rules" && <SettingsEditor cards={cards} value={room?.settings ?? settings} onClose={() => setModal(null)} onSave={(next) => { if (room) { void run(async () => { await command("settings", { settings: { ...next, elixirRanges: next.elixirRanges ?? null, minElixir: next.minElixir ?? null, maxElixir: next.maxElixir ?? null, includeCards: next.includeCards ?? null, excludeCards: next.excludeCards ?? null, includedCardIds: next.includedCardIds ?? null, excludedCardIds: next.excludedCardIds ?? null, cardKinds: next.cardKinds ?? null, rarities: next.rarities ?? null, families: next.families ?? null } }); setModal(null); }); } else { setSettings(next); storage.set("settings", next); setModal(null); } }} />}
    {modal === "collection" && <CollectionEditor cards={cards} value={collection} onClose={() => setModal(null)} onSave={(next) => { void run(async () => { if (room?.phase === "waiting") await command("collection", { collection: next }); setCollection(next); storage.set("collection", next); setModal(null); }); }} />}
    {modal === "social" && room?.phase !== "drafting" && <SocialPanel social={social} name={name} onNameChange={(next) => { setName(next); storage.set("name", next); }} settings={room?.settings ?? settings} collection={collection} friendToken={friendToken} onFriendTokenChange={(token) => { setFriendToken(token); if (!token) { const query = new URLSearchParams(window.location.hash.slice(1)); if (query.has("friend")) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`); } }} onAcceptInvite={(inviteId) => openSocialInvite(inviteId, true)} onOpenInvite={(inviteId) => openSocialInvite(inviteId, false)} onLegacyInvite={() => { setModal(null); void start(false); }} onClose={closeSocial} onCopy={copy} />}
    {modal === "join" && <div className="arena-modal-backdrop" onClick={() => { navigationEpoch.current += 1; setModal(null); }}><form className="arena-modal join-modal" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); const expectedNavigation = ++navigationEpoch.current; storage.set("name", name.trim() || "Player"); void run(async () => { const session = await joinArenaRoom({ inviteCode: invite.trim().toUpperCase(), name: name.trim() || "Player", collection }); if (navigationEpoch.current === expectedNavigation) openSession(session); }); }}><header className="modal-heading"><h2>Join your friend</h2><button type="button" className="icon-button" onClick={() => { navigationEpoch.current += 1; setModal(null); }} aria-label="Close join">×</button></header><label>Your name<input value={name} maxLength={24} onChange={(event) => setName(event.target.value)} autoComplete="nickname" /></label><label>Room code<input className="code-input" value={invite} onChange={(event) => setInvite(event.target.value.toUpperCase())} maxLength={12} placeholder="ABC123" autoCapitalize="characters" autoComplete="off" required /></label><button className="royale-button gold full-width" disabled={pending || !invite.trim()}>Enter battle room</button><button className="text-button" type="button" onClick={() => setModal("collection")}>Check my collection</button></form></div>}
    <AccountControl hideTrigger />
  </main>;
}
