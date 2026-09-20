interface CountdownBarProps {
  remainingMs: number | null;
  pickSeconds: number;
  running: boolean;
}

export function CountdownBar({ remainingMs, pickSeconds, running }: CountdownBarProps) {
  if (remainingMs === null) return <div className="arena-timer is-idle" aria-hidden="true" />;

  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const ratio = Math.max(0, Math.min(1, remainingMs / Math.max(1, pickSeconds * 1000)));
  const warning = seconds <= 4;

  return (
    <div className={`arena-timer ${warning ? "is-warning" : ""} ${running ? "is-running" : ""}`} aria-live="off">
      <span className="arena-timer-label">Time left</span>
      <span className="arena-timer-track" aria-hidden="true">
        <span className="arena-timer-fill" style={{ transform: `scaleX(${ratio})` }} />
      </span>
      <strong aria-label={`${seconds} seconds remaining`}>{seconds}<small>sec</small></strong>
    </div>
  );
}
