import { describe, expect, it } from "vitest";
import type { TrackerInsightBucket } from "@draft-royale/shared";
import { formatDelta, formatInterval, heatColor, isSmallSample, linearScale, nearestPointIndex, niceTicks, rateWithSample, tiltTakeaway, trophyGeometry, wilsonInterval } from "./insightsMath";

const bucket = (key: string, wins: number, losses: number, draws = 0): TrackerInsightBucket => ({ key, label: key, min: null, max: null, games: wins + losses + draws, wins, losses, draws, unknown: 0, winRate: wins + losses + draws ? wins / (wins + losses + draws) : null });
const box = { width: 300, height: 160, left: 40, right: 10, top: 10, bottom: 20 };
const point = (battleTime: string, trophies: number, change = 30) => ({ battleId: battleTime, battleTime, trophies, change, modeName: "Ladder" });

describe("rates always carry their sample", () => {
  it("prints the games beside the rate and flags small samples below ten decided games", () => {
    expect(rateWithSample({ winRate: 0.583, games: 24 })).toBe("58% · 24 games");
    expect(rateWithSample({ winRate: null, games: 1 })).toBe("— · 1 game");
    expect(isSmallSample({ wins: 5, losses: 4, draws: 0 })).toBe(true);
    expect(isSmallSample({ wins: 5, losses: 4, draws: 1 })).toBe(false);
  });

  it("formats deltas in points and intervals as a range", () => {
    expect([formatDelta(0.124), formatDelta(-0.08), formatDelta(0.012), formatDelta(0), formatDelta(null)]).toEqual(["+12 pts", "−8 pts", "+1 pt", "±0 pts", ""]);
    expect(formatInterval({ lower: 0.412, upper: 0.779 })).toBe("41–78%");
    expect(formatInterval(null)).toBe("");
  });

  it("matches the server's Wilson interval", () => {
    const interval = wilsonInterval(5, 10)!;
    expect(interval.lower).toBeCloseTo(0.2366, 3);
    expect(interval.upper).toBeCloseTo(0.7634, 3);
    expect(wilsonInterval(0, 0)).toBeNull();
  });
});

describe("tilt takeaway", () => {
  it("stays silent unless both compared buckets hold ten decided games", () => {
    expect(tiltTakeaway({ byPriorLosses: [bucket("0", 9, 0), bucket("1", 20, 20), bucket("2", 10, 10), bucket("3+", 5, 5)] })).toBeNull();
    expect(tiltTakeaway({ byPriorLosses: [bucket("0", 30, 20), bucket("1", 3, 3), bucket("2", 1, 1), bucket("3+", 0, 1)] })).toBeNull();
    expect(tiltTakeaway({ byPriorLosses: [] })).toBeNull();
  });

  it("compares no-loss games with games after two or more losses when that run is large enough", () => {
    const sentence = tiltTakeaway({ byPriorLosses: [bucket("0", 120, 80), bucket("1", 20, 20), bucket("2", 20, 40), bucket("3+", 10, 30)] });
    expect(sentence).toBe("Straight after 2 or more losses in a row you win 30% of 100 games, against 60% of 200 games with no loss before: 30 points lower.");
  });

  it("falls back to any loss, names another player, and says when the ranges overlap", () => {
    const sentence = tiltTakeaway({ byPriorLosses: [bucket("0", 8, 6), bucket("1", 3, 5), bucket("2", 1, 2), bucket("3+", 0, 1)] }, "Rival");
    expect(sentence).toBe("Straight after a loss Rival wins 33% of 12 games, against 57% of 14 games with no loss before: 24 points lower. The ranges overlap, so this could still be chance.");
  });

  it("reports a near-identical rate as about the same", () => {
    expect(tiltTakeaway({ byPriorLosses: [bucket("0", 50, 50), bucket("1", 0, 0), bucket("2", 10, 10), bucket("3+", 5, 5)] })).toBe("You win about as often straight after 2 or more losses in a row (50% of 30 games) as with no loss before (50% of 100 games).");
  });
});

describe("chart scale helpers", () => {
  it("scales linearly and centres a zero-width domain", () => {
    const scale = linearScale(0, 10, 100, 200);
    expect([scale(0), scale(5), scale(10)]).toEqual([100, 150, 200]);
    expect(linearScale(7, 7, 0, 50)(7)).toBe(25);
  });

  it("produces round ticks inside the domain", () => {
    expect(niceTicks(7012, 7488, 3)).toEqual([7200, 7400]);
    expect(niceTicks(0, 100, 4)).toEqual([0, 50, 100]);
    expect(niceTicks(5000, 5000)).toEqual([5000]);
    expect(niceTicks(Number.NaN, 5)).toEqual([]);
  });

  it("places a single trophy point in the middle of the plot", () => {
    const geometry = trophyGeometry([point("2026-09-01T10:00:00.000Z", 7000)], box);
    expect(geometry.points).toHaveLength(1);
    expect(geometry.points[0]).toMatchObject({ x: 165, y: 75 });
    expect(geometry.yTicks).toEqual([{ value: 7000, y: 75 }]);
  });

  it("orders points by time, keeps them inside the plot and drops unreadable rows", () => {
    const geometry = trophyGeometry([point("2026-09-03T10:00:00.000Z", 7100), point("not a date", 1), point("2026-09-01T10:00:00.000Z", 7000), point("2026-09-02T10:00:00.000Z", 6900, -30)], box);
    expect(geometry.points.map((item) => item.point.trophies)).toEqual([7000, 6900, 7100]);
    expect(geometry.points.map((item) => item.x)).toEqual([40, 165, 290]);
    for (const item of geometry.points) { expect(item.y).toBeGreaterThanOrEqual(box.top); expect(item.y).toBeLessThanOrEqual(box.height - box.bottom); }
    expect(geometry.path.startsWith("M40 ")).toBe(true);
    expect([geometry.min, geometry.max]).toEqual([6900, 7100]);
  });

  it("handles five hundred points and finds the nearest one to a pointer", () => {
    const geometry = trophyGeometry(Array.from({ length: 500 }, (_, index) => point(new Date(Date.UTC(2026, 0, 1) + index * 3_600_000).toISOString(), 6000 + index)), box);
    expect(geometry.points).toHaveLength(500);
    expect(nearestPointIndex(geometry.points, 0)).toBe(0);
    expect(nearestPointIndex(geometry.points, 9999)).toBe(499);
    expect(nearestPointIndex([], 5)).toBe(-1);
  });
});

describe("heat colour", () => {
  it("is neutral without decided games and fades small samples towards the panel colour", () => {
    expect(heatColor(null, 0)).toBe("rgb(38,66,92)");
    const [strongGreen, faintGreen] = [heatColor(1, 40), heatColor(1, 1)].map((value) => Number(value.match(/rgb\(\d+,(\d+),/)![1]));
    expect(strongGreen).toBeGreaterThan(faintGreen!);
    expect(heatColor(0, 40)).not.toBe(heatColor(1, 40));
  });

  it("spends the whole scale between 25% and 75% so realistic win rates stay distinguishable", () => {
    expect(heatColor(0.1, 40)).toBe(heatColor(0.25, 40));
    expect(heatColor(0.9, 40)).toBe(heatColor(0.75, 40));
    expect(heatColor(0.5, 40)).toBe("rgb(74,96,118)");
    expect(heatColor(0.4, 40)).not.toBe(heatColor(0.5, 40));
  });
});
