export type StatsTab = "history" | "rivalries" | "insights";

export const statsTabs: Array<{ key: StatsTab; label: string }> = [
  { key: "history", label: "History" },
  { key: "rivalries", label: "Rivalries" },
  { key: "insights", label: "Insights" },
];

/** "#stats" and any "#stats/…" sub-path belong to the stats surface. */
export const isStatsHash = (hash: string) => hash === "#stats" || hash.startsWith("#stats/");
export const statsTabFromHash = (hash: string): StatsTab => statsTabs.find((tab) => tab.key !== "history" && hash === `#stats/${tab.key}`)?.key ?? "history";
export const statsHash = (tab: StatsTab) => tab === "history" ? "#stats" : `#stats/${tab}`;
