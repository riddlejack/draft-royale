import { useEffect, useMemo, useState } from "react";
import type { ArenaCard, SocialCredential } from "@draft-royale/shared";
import { InsightsBoard } from "./InsightsBoard";
import { RivalryBoard } from "./RivalryBoard";
import { StatsBoard } from "./StatsBoard";
import { statsHash, statsTabFromHash, statsTabs, isStatsHash, type StatsTab } from "./statsTabs";
import { catalogById } from "./trackerCards";
import "./tracker.css";
import "./insights.css";

export interface StatsScreenProps { credential: SocialCredential | null; catalog?: readonly ArenaCard[]; onSignIn?: () => void }

export function StatsScreen({ credential, catalog, onSignIn }: StatsScreenProps) {
  const [tab, setTab] = useState<StatsTab>(() => statsTabFromHash(window.location.hash));
  // The focused player follows the viewer from tab to tab; "" lets the server pick the viewer's own tag.
  const [playerTag, setPlayerTag] = useState("");
  const cardsById = useMemo(() => catalogById(catalog ?? []), [catalog]);

  useEffect(() => {
    const sync = () => { if (isStatsHash(window.location.hash)) setTab(statsTabFromHash(window.location.hash)); };
    window.addEventListener("hashchange", sync); window.addEventListener("popstate", sync);
    return () => { window.removeEventListener("hashchange", sync); window.removeEventListener("popstate", sync); };
  }, []);

  const select = (next: StatsTab) => {
    if (next === tab) return;
    window.history.pushState(null, "", `${window.location.pathname}${window.location.search}${statsHash(next)}`);
    setTab(next);
  };

  if (!credential) return <StatsBoard credential={null} onSignIn={onSignIn} />;
  return <>
    <nav className="tracker-tabs" aria-label="Match record views">{statsTabs.map((item) => <button type="button" key={item.key} className={tab === item.key ? "is-active" : ""} aria-current={tab === item.key ? "page" : undefined} onClick={() => select(item.key)}>{item.label}</button>)}</nav>
    {tab === "history" && <StatsBoard credential={credential} onSignIn={onSignIn} playerTag={playerTag} onPlayerTagChange={setPlayerTag} />}
    {tab === "rivalries" && <RivalryBoard credential={credential} cardsById={cardsById} playerTag={playerTag} onPlayerTagChange={setPlayerTag} />}
    {tab === "insights" && <InsightsBoard credential={credential} cardsById={cardsById} playerTag={playerTag} onPlayerTagChange={setPlayerTag} />}
  </>;
}
