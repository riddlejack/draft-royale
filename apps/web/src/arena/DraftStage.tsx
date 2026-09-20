import { estimatedArenaServerNow } from "./clock";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { arenaElixirAccessibleLabel, type ArenaCard, type ArenaCell, type ArenaForm, type ArenaPickEvent, type ArenaSeat, type ArenaView } from "@draft-royale/shared";
import { ArenaCardFace, assetForForm } from "./components/ArenaCardFace";
import { CountdownBar } from "./components/CountdownBar";
import { DeckTray } from "./components/DeckTray";
import { FormChooser } from "./components/FormChooser";
import "./DraftStage.css";

export interface DraftStageProps {
  room: ArenaView;
  cards: ArenaCard[];
  pending: boolean;
  onPick: (cardKey: string, form: ArenaForm) => Promise<void>;
  onLeave: () => void;
  soundEnabled: boolean;
}

interface ChosenCell {
  cell: ArenaCell;
  card: ArenaCard;
}

interface FlyingPick {
  id: string;
  asset: string;
  left: number;
  top: number;
  width: number;
  height: number;
  deltaX: number;
  deltaY: number;
  targetScale: number;
  delay: number;
}

const DEAL_CELL_DELAY_MS = 54;
const DEAL_CARD_DURATION_MS = 310;
const FLIGHT_DURATION_MS = 610;

function canAnimateInitialDeal(room: ArenaView) {
  if (room.phase !== "drafting" || room.startedAt === null || room.interactiveAt === null) return false;
  if ((estimatedArenaServerNow() ?? room.serverNow) >= room.interactiveAt) return false;
  try {
    return sessionStorage.getItem(`arena-dealt:${room.id}:${room.startedAt}`) !== "1";
  } catch {
    return true;
  }
}

function markDealSeen(room: ArenaView) {
  if (room.startedAt === null) return;
  try {
    sessionStorage.setItem(`arena-dealt:${room.id}:${room.startedAt}`, "1");
  } catch {
    // A private browsing storage failure should never block the draft.
  }
}

function useEstimatedServerNow(serverNow: number, running: boolean) {
  const anchorRef = useRef({ serverNow, performanceNow: performance.now() });
  const [estimatedNow, setEstimatedNow] = useState(serverNow);
  const readEstimatedNow = useCallback(() => {
    const anchor = anchorRef.current;
    return estimatedArenaServerNow() ?? (anchor.serverNow + performance.now() - anchor.performanceNow);
  }, []);

  useEffect(() => {
    anchorRef.current = { serverNow, performanceNow: performance.now() };
    setEstimatedNow(estimatedArenaServerNow() ?? serverNow);
  }, [serverNow]);

  useEffect(() => {
    if (!running) return;
    const update = () => setEstimatedNow(readEstimatedNow());
    const timer = window.setInterval(update, 100);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [readEstimatedNow, running]);

  return { estimatedNow, readEstimatedNow };
}

function megaGrid(poolSize: number) {
  const columns = poolSize <= 16 ? 4 : poolSize <= 36 ? 6 : 8;
  return { columns, rows: Math.max(1, Math.ceil(poolSize / columns)) };
}

function normalizedMegaCells(board: ArenaCell[], poolSize: number) {
  const sorted = [...board].sort((left, right) => left.position - right.position);
  const oneBased = sorted.length > 0 && !sorted.some((cell) => cell.position === 0)
    && sorted.every((cell) => cell.position >= 1 && cell.position <= poolSize);
  const cells: Array<ArenaCell | null> = Array.from({ length: poolSize }, () => null);
  sorted.forEach((cell, index) => {
    const expectedIndex = oneBased ? cell.position - 1 : cell.position;
    const targetIndex = expectedIndex >= 0 && expectedIndex < poolSize ? expectedIndex : index;
    cells[targetIndex] = cell;
  });
  return cells;
}

function pickFeedback(soundEnabled: boolean) {
  if (!soundEnabled) return;
  navigator.vibrate?.(18);
  try {
    const AudioContextConstructor = window.AudioContext;
    const context = new AudioContextConstructor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(420, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(700, context.currentTime + 0.07);
    gain.gain.setValueAtTime(0.035, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.09);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.09);
    oscillator.addEventListener("ended", () => void context.close(), { once: true });
  } catch {
    // Sound is optional; picking must remain available if audio is blocked.
  }
}

export function DraftStage({ room, cards, pending, onPick, onLeave, soundEnabled }: DraftStageProps) {
  const mirror = Boolean(room.settings.mirrorMode);
  const cardsByKey = useMemo(() => new Map(cards.map((card) => [card.key, card])), [cards]);
  const viewer = room.participants.find((participant) => participant.seat === room.viewer) ?? room.participants[0];
  const opponent = room.participants.find((participant) => participant.seat !== room.viewer) ?? room.participants[1];
  const megaStarter = room.megaStarter === null || room.megaStarter === undefined
    ? null
    : room.participants.find((participant) => participant.seat === room.megaStarter);
  const [chooser, setChooser] = useState<ChosenCell | null>(null);
  const [localPending, setLocalPending] = useState(false);
  const [dealStartedAt, setDealStartedAt] = useState<number | null>(() => canAnimateInitialDeal(room) ? room.startedAt : null);
  const [flyingPicks, setFlyingPicks] = useState<FlyingPick[]>([]);
  const lastAnimatedRevision = useRef(room.revision);
  const observedRoomId = useRef(room.id);
  const observedStart = useRef(room.startedAt);
  const flightTimers = useRef<number[]>([]);
  const submitting = useRef(false);
  const previousCardRects = useRef(new Map<string, DOMRect>());

  const clockRunning = room.phase === "drafting" && room.deadlineAt !== null;
  const { estimatedNow, readEstimatedNow } = useEstimatedServerNow(room.serverNow, clockRunning);
  const isInteractive = room.interactiveAt === null || estimatedNow >= room.interactiveAt;
  const localTurn = room.phase === "drafting" && isInteractive && room.activeSeat === room.viewer;
  const remainingMs = room.deadlineAt === null ? null : Math.max(0, room.deadlineAt - estimatedNow);
  const deadlineExpired = room.deadlineAt !== null && remainingMs === 0;
  const canPickNow = localTurn && !deadlineExpired;
  const isDisabled = pending || localPending || !canPickNow;
  // The configured size is a cap; filters may produce a smaller board.
  const megaPoolSize = room.board.length;
  const megaCells = useMemo(() => normalizedMegaCells(room.board, megaPoolSize), [megaPoolSize, room.board]);
  const grid = megaGrid(megaPoolSize);
  const ownOffer = useMemo(() => room.board
    .filter((cell) => cell.offeredTo === undefined || cell.offeredTo === room.viewer)
    .sort((left, right) => left.position - right.position), [room.board, room.viewer]);
  const opponentOffer = useMemo(() => room.board
    .filter((cell) => cell.offeredTo !== undefined && cell.offeredTo !== room.viewer)
    .sort((left, right) => left.position - right.position), [room.board, room.viewer]);
  const displayCells: Array<ArenaCell | null> = room.settings.mode === "mega" ? megaCells : ownOffer;
  const dealCellCount = room.settings.mode === "mega"
    ? megaPoolSize
    : Math.max(1, ownOffer.length + opponentOffer.length);
  const dealCellDelayMs = Math.min(DEAL_CELL_DELAY_MS, Math.floor(1_990 / Math.max(1, dealCellCount - 1)));
  const dealElapsedMs = dealStartedAt === null ? 0 : Math.max(0, (estimatedArenaServerNow() ?? room.serverNow) - dealStartedAt);
  const boardStyle = room.settings.mode === "mega"
    ? {
      "--offer-count": Math.max(1, displayCells.length),
      "--arena-columns": grid.columns,
      "--arena-rows": grid.rows,
      "--arena-ideal-height": `${94 * (grid.rows * 363) / (grid.columns * 302)}vw`,
      aspectRatio: `${grid.columns * 302} / ${grid.rows * 363}`,
    } as CSSProperties
    : { "--offer-count": Math.max(1, ownOffer.length) } as CSSProperties;

  useEffect(() => {
    if (room.startedAt === observedStart.current) return;
    observedStart.current = room.startedAt;
    if (canAnimateInitialDeal(room)) {
      setDealStartedAt(room.startedAt);
      markDealSeen(room);
    } else {
      setDealStartedAt(null);
    }
  }, [room]);

  useEffect(() => {
    if (dealStartedAt === null) return;
    markDealSeen(room);
    const remaining = Math.max(0, (dealCellCount - 1) * dealCellDelayMs + DEAL_CARD_DURATION_MS - dealElapsedMs);
    const timer = window.setTimeout(() => setDealStartedAt(null), remaining + 60);
    return () => window.clearTimeout(timer);
  }, [dealCellCount, dealCellDelayMs, dealElapsedMs, dealStartedAt, room]);

  useEffect(() => () => flightTimers.current.forEach((timer) => window.clearTimeout(timer)), []);

  useLayoutEffect(() => {
    if (room.id !== observedRoomId.current) {
      observedRoomId.current = room.id;
      lastAnimatedRevision.current = room.revision;
      setFlyingPicks([]);
      return;
    }
    if (room.revision <= lastAnimatedRevision.current) return;
    const unseenEvents = room.events
      .filter((event) => event.revision > lastAnimatedRevision.current)
      .sort((left, right) => left.revision - right.revision);
    lastAnimatedRevision.current = room.revision;
    if (document.visibilityState !== "visible" || unseenEvents.length === 0) return;

    const makeFlight = (
      event: ArenaPickEvent,
      seat: ArenaSeat,
      cardKey: string,
      form: ArenaForm,
      delay: number,
    ): FlyingPick[] => {
      const source = Array.from(document.querySelectorAll<HTMLElement>("[data-arena-card-key]"))
        .find((element) => element.dataset.arenaCardKey === cardKey);
      const participant = room.participants.find((candidate) => candidate.seat === seat);
      let matchingTrayIndex = -1;
      participant?.deck.forEach((entry, entryIndex) => {
        if (entry.cardKey === cardKey && entry.form === form) matchingTrayIndex = entryIndex;
      });
      const trayIndex = Math.min(7, matchingTrayIndex >= 0 ? matchingTrayIndex : Math.max(0, (participant?.deckCount ?? 1) - 1));
      const target = document.querySelector<HTMLElement>(`[data-arena-tray-seat="${seat}"][data-arena-tray-card-key="${cardKey}"]`)
        ?? document.querySelector<HTMLElement>(`[data-arena-tray-seat="${seat}"][data-arena-tray-slot="${trayIndex}"]`);
      const card = cardsByKey.get(cardKey);
      const sourceRect = previousCardRects.current.get(cardKey) ?? source?.getBoundingClientRect();
      if (!sourceRect || !target || !card) return [];
      const targetRect = target.getBoundingClientRect();
      if (sourceRect.width === 0 || targetRect.width === 0) return [];
      const targetScale = Math.min(targetRect.width / sourceRect.width, targetRect.height / sourceRect.height);
      return [{
        id: `${event.revision}-${seat}-${cardKey}`,
        asset: assetForForm(card, form),
        left: sourceRect.left,
        top: sourceRect.top,
        width: sourceRect.width,
        height: sourceRect.height,
        deltaX: targetRect.left + targetRect.width / 2 - (sourceRect.left + sourceRect.width / 2),
        deltaY: targetRect.top + targetRect.height / 2 - (sourceRect.top + sourceRect.height / 2),
        targetScale,
        delay,
      }];
    };

    const nextFlights = unseenEvents.flatMap((event, index): FlyingPick[] => {
      const primary = makeFlight(event, event.seat, event.cardKey, event.form, index * 120);
      const received = mirror
        ? makeFlight(event, event.seat === "a" ? "b" : "a", event.cardKey, event.form, index * 120 + 70)
        : event.received
        ? makeFlight(event, event.received.seat, event.received.cardKey, event.received.form, index * 120 + 70)
        : [];
      return [...primary, ...received];
    });

    if (nextFlights.length === 0) return;
    setFlyingPicks((current) => [...current, ...nextFlights]);
    for (const flight of nextFlights) {
      const timer = window.setTimeout(() => {
        setFlyingPicks((current) => current.filter((candidate) => candidate.id !== flight.id));
      }, FLIGHT_DURATION_MS + flight.delay + 50);
      flightTimers.current.push(timer);
    }
  }, [cardsByKey, mirror, room.events, room.id, room.revision]);

  useLayoutEffect(() => {
    const nextRects = new Map<string, DOMRect>();
    document.querySelectorAll<HTMLElement>("[data-arena-card-key]").forEach((element) => {
      const cardKey = element.dataset.arenaCardKey;
      if (cardKey) nextRects.set(cardKey, element.getBoundingClientRect());
    });
    previousCardRects.current = nextRects;
  }, [room.board, room.id, room.revision]);

  useEffect(() => {
    if (!chooser) return;
    const current = room.board.find((cell) => cell.position === chooser.cell.position
      && (cell.offeredTo === undefined || cell.offeredTo === room.viewer));
    if (!current || current.selectedBy !== null || !canPickNow) setChooser(null);
  }, [canPickNow, chooser, room.board, room.viewer]);

  const submitPick = useCallback(async (cell: ArenaCell, form: ArenaForm) => {
    const deadlinePassedNow = room.deadlineAt !== null && readEstimatedNow() >= room.deadlineAt;
    if (pending || submitting.current || !canPickNow || deadlinePassedNow || cell.selectedBy !== null || !cell.legalForms.includes(form)) return;
    submitting.current = true;
    setLocalPending(true);
    pickFeedback(soundEnabled);
    try {
      await onPick(cell.cardKey, form);
      setChooser(null);
    } catch {
      // The parent owns request error presentation; keep this surface interactive.
    } finally {
      submitting.current = false;
      setLocalPending(false);
    }
  }, [canPickNow, onPick, pending, readEstimatedNow, room.deadlineAt, soundEnabled]);

  const dismissChooser = useCallback(() => setChooser(null), []);

  const activateCell = useCallback((cell: ArenaCell, card: ArenaCard) => {
    if (isDisabled || cell.selectedBy !== null || cell.legalForms.length === 0) return;
    if (cell.legalForms.length === 1) {
      void submitPick(cell, cell.legalForms[0]!);
      return;
    }
    setChooser({ cell, card });
  }, [isDisabled, submitPick]);

  const turnLabel = room.phase === "waiting"
    ? "Waiting for Opponent"
    : room.phase === "complete"
    ? "Draft Complete"
    : !isInteractive
      ? "Dealing Cards"
      : deadlineExpired
        ? "Time's Up"
        : localTurn
        ? mirror ? "Choose for Both" : "Pick a Card"
        : mirror ? "Opponent Chooses for Both" : "Opponent's Turn";
  const offerMode = room.settings.mode !== "mega";
  const privateMode = offerMode && !mirror;
  const grouped = room.settings.mode === "triple" && Boolean(room.roundSchedule);
  const regularRoundCount = room.roundSchedule?.filter((kind) => kind === "base").length ?? 5;
  const currentRoundNumber = room.currentRound?.roundNumber ?? (room.roundSchedule?.length ?? 8) + 1;
  const presetMirror = room.participants.some((participant) => participant.deck.some((entry) => entry.cardKey === "mirror" && entry.preset));
  const specialRoundLabel = room.currentRound?.kind === "evolution"
    ? `Evolution ${room.currentRound.roundNumber} of 2`
    : room.currentRound?.kind === "hero_champion" ? "Choose a Hero or Champion" : "Choose Your Card";
  const boardClass = offerMode ? `is-offer is-${room.settings.mode}` : "is-mega";
  const sharedPickNumber = Math.min(room.totalPicks, Math.max(1, room.pickNumber));
  const draftHeading = grouped ? <div className="arena-round-plan" aria-label={`Round schedule: two Evolution rounds, one Hero or Champion round, then ${regularRoundCount} regular rounds`}>
    {[
      { label: "Evo 1", start: 1, end: 1, kind: "evolution" },
      { label: "Evo 2", start: 2, end: 2, kind: "evolution" },
      { label: "Hero", start: 3, end: 3, kind: "hero" },
      { label: `Regular ×${regularRoundCount}`, start: 4, end: 3 + regularRoundCount, kind: "base" },
    ].map((step) => <span key={step.start} className={`is-${step.kind} ${currentRoundNumber > step.end ? "is-complete" : ""} ${currentRoundNumber >= step.start && currentRoundNumber <= step.end ? "is-current" : ""}`} aria-current={currentRoundNumber >= step.start && currentRoundNumber <= step.end ? "step" : undefined}>{currentRoundNumber > step.end ? "✓ " : ""}{step.label}</span>)}
  </div> : <>
    {room.settings.mode === "mega" && !mirror && megaStarter ? <div className="arena-starter-note" aria-live="polite">{megaStarter.name} opens this Mega Draft</div> : null}
    <div
    className={`arena-turn-banner ${localTurn ? "is-local" : "is-opponent"} ${privateMode && room.settings.mode === "triple" ? "is-triple-placeholder" : ""}`}
    aria-live={privateMode && room.settings.mode === "triple" ? "off" : "polite"}
    aria-hidden={privateMode && room.settings.mode === "triple"}
  >
    {privateMode && room.settings.mode === "triple" ? null : turnLabel}
    </div>
  </>;

  const renderCell = (cell: ArenaCell | null, index: number, opponentChoice = false) => {
    if (!cell) return <span className="arena-cell is-empty" key={`empty-${index}`} aria-hidden="true" />;
    const card = cardsByKey.get(cell.cardKey);
    const selected = cell.selectedBy !== null;
    const unavailable = !opponentChoice && isInteractive && !selected && cell.legalForms.length === 0 && (!mirror || localTurn);
    const buttonDisabled = opponentChoice || isDisabled || selected || cell.legalForms.length === 0 || !card;
    const dealDelay = index * dealCellDelayMs - dealElapsedMs;
    return (
      <button
        type="button"
        className={`arena-cell ${selected ? "is-picked" : ""} ${opponentChoice ? "is-opponent-choice" : ""}`}
        key={`${cell.offeredTo ?? "pool"}-${cell.position}-${cell.cardKey}`}
        data-arena-position={cell.position}
        data-arena-card-key={cell.cardKey}
        style={{ "--deal-delay": `${dealDelay}ms` } as CSSProperties}
        disabled={buttonDisabled}
        onClick={() => card && !opponentChoice && activateCell(cell, card)}
        aria-label={card
          ? opponentChoice
            ? `${opponent?.name ?? "Opponent"} can choose ${card.name}, ${arenaElixirAccessibleLabel(card.elixir)}`
            : `${card.name}, ${arenaElixirAccessibleLabel(card.elixir)}${selected ? ", already selected" : cell.legalForms.length > 1 ? ", choose form" : ""}`
          : "Hidden card"}
      >
        {card ? (
          <ArenaCardFace
            card={card}
            form={cell.selectedForm ?? cell.displayForm ?? (cell.legalForms.length === 1 ? cell.legalForms[0] : "base")}
            legalForms={selected || opponentChoice || (grouped && cell.displayForm) ? [] : cell.legalForms}
            muted={!opponentChoice && (((!mirror && !localTurn && isInteractive) && !selected) || unavailable)}
            selected={selected}
            className={unavailable ? "is-unavailable" : ""}
          />
        ) : <span className="arena-card-back"><span /></span>}
      </button>
    );
  };

  if (!viewer || !opponent) return null;

  return (
    <main className={`draft-stage mode-${room.settings.mode} ${mirror ? "is-mirror" : ""} ${localTurn ? "is-local-turn" : "is-opponent-turn"}`}>
      <button className="arena-leave" type="button" onClick={onLeave} aria-label="Leave draft">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" /></svg>
      </button>

      <div className="arena-playfield">
        <DeckTray
          participant={opponent}
          cardsByKey={cardsByKey}
          side="opponent"
          concealCards={privateMode && room.settings.mode === "triple"}
          hiddenSide="start"
          active={room.activeSeat === opponent.seat && room.phase === "drafting"}
          seat={opponent.seat}
        />

        {mirror ? <div className="arena-mirror-heading"><span className="arena-mirror-badge">{presetMirror ? "Mirror included" : "Mirror"} · {sharedPickNumber}/{room.totalPicks} {presetMirror ? "picks" : "shared picks"}</span>{draftHeading}</div> : draftHeading}

        <section className="arena-board-shell" aria-label={mirror && offerMode ? "Shared card offer" : privateMode ? "Your card offer" : "Mega Draft card pool"}>
          {mirror && offerMode ? (
            <div className="arena-shared-offers">
              <span className={`arena-offer-label ${localTurn ? "" : "is-opponent"}`} aria-live="polite">
                {grouped ? localTurn ? specialRoundLabel : turnLabel : "One choice. Both decks."}
                {grouped && room.currentRound && <small className="arena-round-number">Round {room.currentRound.roundNumber} of {room.currentRound.totalRounds}</small>}
              </span>
              <div className={`arena-board ${boardClass} is-shared-offer ${dealStartedAt !== null ? "is-dealing" : ""}`} style={boardStyle}>
                {displayCells.map((cell, index) => renderCell(cell, index))}
              </div>
            </div>
          ) : room.settings.mode === "triple" ? (
            <div className={`arena-triple-offers ${dealStartedAt !== null ? "is-dealing" : ""}`}>
              <span className="arena-offer-label is-opponent">{opponentOffer.length ? "Opponent Chooses From" : "Opponent Ready"}</span>
              <div
                className="arena-board is-offer is-triple is-opponent-offer"
                style={{ "--offer-count": Math.max(1, opponentOffer.length) } as CSSProperties}
              >
                {opponentOffer.map((cell, index) => renderCell(cell, index, true))}
              </div>
              <span className="arena-offer-label" aria-live="polite">
                {localTurn ? grouped ? specialRoundLabel : "Choose Your Card" : turnLabel}
                {grouped && room.currentRound && <small className="arena-round-number">Round {room.currentRound.roundNumber} of {room.currentRound.totalRounds}</small>}
              </span>
              <div className="arena-board is-offer is-triple is-viewer-offer" style={boardStyle}>
                {ownOffer.map((cell, index) => renderCell(cell, opponentOffer.length + index))}
              </div>
            </div>
          ) : (
            <div
              className={`arena-board ${boardClass} ${dealStartedAt !== null ? "is-dealing" : ""}`}
              style={boardStyle}
            >
              {displayCells.map((cell, index) => renderCell(cell, index))}
            </div>
          )}
        </section>

        <CountdownBar
          remainingMs={room.phase === "drafting" && isInteractive ? remainingMs : null}
          pickSeconds={room.settings.pickSeconds}
          running={clockRunning && isInteractive}
        />

        <DeckTray
          participant={viewer}
          cardsByKey={cardsByKey}
          side="viewer"
          hiddenSide="end"
          active={room.activeSeat === viewer.seat && room.phase === "drafting"}
          seat={viewer.seat}
        />
      </div>

      <div className="arena-flight-layer" aria-hidden="true">
        {flyingPicks.map((flight) => (
          <img
            key={flight.id}
            className="arena-flying-card"
            src={flight.asset}
            alt=""
            style={{
              left: flight.left,
              top: flight.top,
              width: flight.width,
              height: flight.height,
              animationDelay: `${flight.delay}ms`,
              "--flight-x": `${flight.deltaX}px`,
              "--flight-y": `${flight.deltaY}px`,
              "--flight-scale": flight.targetScale,
            } as CSSProperties}
          />
        ))}
      </div>

      {chooser ? (
        <FormChooser
          card={chooser.card}
          forBothPlayers={mirror}
          legalForms={chooser.cell.legalForms}
          disabled={pending || localPending}
          onChoose={(form) => void submitPick(chooser.cell, form)}
          onDismiss={dismissChooser}
        />
      ) : null}
    </main>
  );
}
