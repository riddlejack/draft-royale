import type { TrackerInsightBucket, TrackerRateInterval, TrackerTally, TrackerTiltInsight, TrackerTrophyPoint } from "@draft-royale/shared";

/** Below this many decided games a rate is shown muted and labelled as a small sample. */
export const SMALL_SAMPLE = 10;

type Record4 = Pick<TrackerTally, "wins" | "losses" | "draws">;
export const decidedGames = (tally: Record4) => tally.wins + tally.losses + tally.draws;
export const isSmallSample = (tally: Record4) => decidedGames(tally) < SMALL_SAMPLE;
export const formatRate = (value: number | null) => value === null ? "—" : `${Math.round(value * 100)}%`;
export const gamesLabel = (games: number) => `${games} ${games === 1 ? "game" : "games"}`;
/** A rate is never shown without the games behind it. */
export const rateWithSample = (tally: Pick<TrackerTally, "winRate" | "games">) => `${formatRate(tally.winRate)} · ${gamesLabel(tally.games)}`;
export const formatInterval = (interval: TrackerRateInterval | null) => interval ? `${Math.round(interval.lower * 100)}–${Math.round(interval.upper * 100)}%` : "";
export const formatDelta = (delta: number | null) => {
  if (delta === null) return "";
  const points = Math.round(delta * 100);
  return `${points > 0 ? "+" : points < 0 ? "−" : "±"}${Math.abs(points)} ${Math.abs(points) === 1 ? "pt" : "pts"}`;
};

const WILSON_Z = 1.96;
/** Wilson 95% score interval, the same one the server uses for card rankings. */
export const wilsonInterval = (wins: number, decided: number): TrackerRateInterval | null => {
  if (decided <= 0) return null;
  const rate = wins / decided; const z2 = WILSON_Z * WILSON_Z; const scale = 1 + z2 / decided;
  const centre = (rate + z2 / (2 * decided)) / scale;
  const margin = WILSON_Z * Math.sqrt(rate * (1 - rate) / decided + z2 / (4 * decided * decided)) / scale;
  return { lower: Math.max(0, centre - margin), upper: Math.min(1, centre + margin) };
};

export const mergeTallies = (tallies: readonly Record4[]) => {
  const merged = { wins: 0, losses: 0, draws: 0 };
  for (const tally of tallies) { merged.wins += tally.wins; merged.losses += tally.losses; merged.draws += tally.draws; }
  const decided = decidedGames(merged);
  return { ...merged, decided, winRate: decided ? merged.wins / decided : null };
};

/**
 * One sentence comparing games played with no loss directly before against games played on a losing run.
 * It is only written when both sides hold at least SMALL_SAMPLE decided games; the run is "2+ losses" when that
 * bucket is large enough and "a loss" otherwise. It says so when the two Wilson intervals overlap.
 */
export const tiltTakeaway = (tilt: Pick<TrackerTiltInsight, "byPriorLosses">, subject = "you"): string | null => {
  const byKey = new Map(tilt.byPriorLosses.map((bucket: TrackerInsightBucket) => [bucket.key, bucket]));
  const pick = (keys: string[]) => mergeTallies(keys.flatMap((key) => byKey.get(key) ?? []));
  const fresh = pick(["0"]);
  if (fresh.decided < SMALL_SAMPLE || fresh.winRate === null) return null;
  const candidates = [{ label: "2 or more losses in a row", tally: pick(["2", "3+"]) }, { label: "a loss", tally: pick(["1", "2", "3+"]) }];
  const run = candidates.find((candidate) => candidate.tally.decided >= SMALL_SAMPLE && candidate.tally.winRate !== null);
  if (!run) return null;
  const Subject = subject.slice(0, 1).toUpperCase() + subject.slice(1);
  const verb = subject === "you" ? "win" : "wins";
  const after = `${formatRate(run.tally.winRate)} of ${run.tally.decided} games`; const before = `${formatRate(fresh.winRate)} of ${fresh.decided} games`;
  const points = Math.round((run.tally.winRate! - fresh.winRate) * 100);
  const freshInterval = wilsonInterval(fresh.wins, fresh.decided)!; const runInterval = wilsonInterval(run.tally.wins, run.tally.decided)!;
  const overlap = freshInterval.lower <= runInterval.upper && runInterval.lower <= freshInterval.upper;
  const caveat = overlap ? " The ranges overlap, so this could still be chance." : "";
  if (Math.abs(points) < 3) return `${Subject} ${verb} about as often straight after ${run.label} (${after}) as with no loss before (${before}).`;
  return `Straight after ${run.label} ${subject} ${verb} ${after}, against ${before} with no loss before: ${Math.abs(points)} points ${points < 0 ? "lower" : "higher"}.${caveat}`;
};

/** Maps a domain onto a range; a zero-width domain lands in the middle of the range instead of dividing by zero. */
export const linearScale = (domainMin: number, domainMax: number, rangeMin: number, rangeMax: number) => {
  const span = domainMax - domainMin;
  return (value: number) => span === 0 || !Number.isFinite(span) ? (rangeMin + rangeMax) / 2 : rangeMin + (value - domainMin) / span * (rangeMax - rangeMin);
};

/** Round tick values covering [min, max]; always at least one tick, including when min equals max. */
export const niceTicks = (min: number, max: number, target = 4): number[] => {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min > max) [min, max] = [max, min];
  if (min === max) return [min];
  const rough = (max - min) / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? 10 * magnitude;
  const ticks: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step) ticks.push(Math.round(value / step) * step);
  return ticks.length ? ticks : [min];
};

export interface ChartBox { width: number; height: number; left: number; right: number; top: number; bottom: number }
export interface TrophyChartPoint { x: number; y: number; point: TrophyChartSource }
type TrophyChartSource = Pick<TrackerTrophyPoint, "battleTime" | "trophies" | "change" | "modeName" | "battleId">;
export interface TrophyChartGeometry { points: TrophyChartPoint[]; path: string; yTicks: Array<{ value: number; y: number }>; min: number; max: number; first: TrophyChartSource | null; last: TrophyChartSource | null }

/** Geometry for one trophy series, x by battle time. Points with an unreadable time or trophy value are dropped. */
export const trophyGeometry = (source: readonly TrophyChartSource[], box: ChartBox): TrophyChartGeometry => {
  const rows = source.map((point) => ({ point, ms: Date.parse(point.battleTime) })).filter((row) => Number.isFinite(row.ms) && Number.isFinite(row.point.trophies)).sort((left, right) => left.ms - right.ms);
  if (!rows.length) return { points: [], path: "", yTicks: [], min: 0, max: 0, first: null, last: null };
  const values = rows.map((row) => row.point.trophies);
  const min = Math.min(...values); const max = Math.max(...values);
  const pad = max === min ? 1 : (max - min) * 0.08;
  const x = linearScale(rows[0]!.ms, rows.at(-1)!.ms, box.left, box.width - box.right);
  const y = linearScale(min - pad, max + pad, box.height - box.bottom, box.top);
  const round = (value: number) => Math.round(value * 10) / 10;
  const points = rows.map((row) => ({ x: round(x(row.ms)), y: round(y(row.point.trophies)), point: row.point }));
  const path = points.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join("");
  return { points, path, yTicks: niceTicks(min, max, 3).map((value) => ({ value, y: round(y(value)) })), min, max, first: rows[0]!.point, last: rows.at(-1)!.point };
};

export const nearestPointIndex = (points: readonly { x: number }[], x: number) => {
  let best = -1; let distance = Number.POSITIVE_INFINITY;
  points.forEach((point, index) => { const next = Math.abs(point.x - x); if (next < distance) { distance = next; best = index; } });
  return best;
};

const LOSS = [158, 56, 72]; const EVEN = [74, 96, 118]; const WIN = [58, 138, 72]; const NEUTRAL = [38, 66, 92];
export const HEAT_LOW = 0.25; export const HEAT_HIGH = 0.75;
/**
 * Diverging red–slate–green scale. Real win rates sit in a narrow band, so the scale runs from HEAT_LOW to HEAT_HIGH rather than 0–100%.
 * The colour fades towards the panel colour while the sample is small so a 1–0 hour does not shout.
 */
export const heatColor = (winRate: number | null, decided: number) => {
  if (winRate === null || decided <= 0) return `rgb(${NEUTRAL.join(",")})`;
  const position = Math.min(1, Math.max(0, (winRate - HEAT_LOW) / (HEAT_HIGH - HEAT_LOW)));
  const [from, to, local] = position < 0.5 ? [LOSS, EVEN, position * 2] : [EVEN, WIN, (position - 0.5) * 2];
  const weight = Math.min(1, decided / SMALL_SAMPLE) * 0.85 + 0.15;
  const channel = (index: number) => Math.round(NEUTRAL[index]! + (from[index]! + (to[index]! - from[index]!) * local - NEUTRAL[index]!) * weight);
  return `rgb(${channel(0)},${channel(1)},${channel(2)})`;
};
