import { useEffect, useState } from "react";
import { LogIn, UserRound, X } from "lucide-react";
import { clearSocialIdentity, readSocialIdentity, writeSocialIdentity } from "../socialClient";
import { storage } from "../client";
import "./accounts.css";

interface ClubAccount { username: string; displayName: string; tag: string; profileId: string }
const initialPlayers = [ { displayName: "PlayerOne", tag: "#2PYL0Q8" }, { displayName: "PlayerThree", tag: "#9GULPC02" }, { displayName: "PlayerTwo", tag: "#8QRJCV2" } ];
const rememberedAccount = (): ClubAccount | null => {
  try {
    const raw = JSON.parse(localStorage.getItem("draft-royale:account") ?? "null") as ClubAccount | null;
    return raw && raw.profileId === readSocialIdentity()?.profileId ? raw : null;
  } catch { return null; }
};
export function AccountButton() {
  const account = rememberedAccount();
  return <button className="small-button account-button" onClick={() => window.dispatchEvent(new Event("draft-royale:sign-in"))}>{account ? <UserRound size={16} /> : <LogIn size={16} />}<span>{account?.displayName ?? "Sign in"}</span></button>;
}
export function AccountControl({ hideTrigger = false }: { hideTrigger?: boolean }) {
  const [account, setAccount] = useState(rememberedAccount);
  const [open, setOpen] = useState(false);
  const [players, setPlayers] = useState(initialPlayers);
  const [username, setUsername] = useState("PlayerOne");
  const [password, setPassword] = useState("");
  const [newPlayer, setNewPlayer] = useState(false);
  const [tag, setTag] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/accounts", { signal: abort.signal }).then((response) => response.json()).then((data: { players?: typeof initialPlayers }) => { if (Array.isArray(data.players)) setPlayers(data.players); }).catch(() => {});
    const identity = readSocialIdentity();
    if (identity) fetch("/api/accounts/session", { headers: { Authorization: `Bearer ${identity.token}` }, signal: abort.signal })
      .then((response) => response.ok ? response.json() : null).then((data: { account?: ClubAccount } | null) => { if (data?.account) { setAccount(data.account); localStorage.setItem("draft-royale:account", JSON.stringify(data.account)); } }).catch(() => {});
    return () => abort.abort();
  }, []);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("draft-royale:sign-in", show);
    return () => window.removeEventListener("draft-royale:sign-in", show);
  }, []);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open]);
  async function signIn() {
    if (pending) return;
    setPending(true); setError("");
    try {
      const response = await fetch(`/api/accounts/${newPlayer ? "register" : "login"}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newPlayer ? { displayName: username, tag } : { username, password }), signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Sign-in failed.");
      if (!data.credential?.token || data.account?.profileId !== data.credential.profileId) throw new Error("The account response was incomplete.");
      // Preserve the former browser profile so changing accounts does not destroy its recovery credential.
      const previous = readSocialIdentity();
      if (previous?.profileId && previous.profileId !== data.credential.profileId) localStorage.setItem(`draft-royale:previous-profile:${previous.profileId}`, JSON.stringify(previous));
      writeSocialIdentity(data.credential);
      localStorage.setItem("draft-royale:account", JSON.stringify(data.account));
      storage.set("name", data.account.displayName);
      window.location.reload();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to sign in. Try again."); }
    finally { setPending(false); }
  }
  return <>
    {!hideTrigger && <button className="small-button account-button" onClick={() => setOpen(true)}>{account ? <UserRound size={16} /> : <LogIn size={16} />}<span>{account?.displayName ?? "Sign in"}</span></button>}
    {open && <div className="club-account-backdrop" onClick={() => setOpen(false)}><section className="club-account-panel" role="dialog" aria-modal="true" aria-label="Player account" onClick={(event) => event.stopPropagation()}>
      <header><div><span className="club-eyebrow">YOUR FRIEND GROUP</span><h2>{account ? account.displayName : "Pick your player"}</h2></div><button className="icon-button" onClick={() => setOpen(false)} aria-label="Close sign in"><X /></button></header>
      {account ? <div className="club-account-current"><p className="club-player-tag">{account.tag}</p><p>This device is signed in. Your friends, published decks, and match records stay with your player profile.</p><button className="royale-button blue" onClick={() => { clearSocialIdentity(); localStorage.removeItem("draft-royale:account"); storage.set("name", "Player"); window.location.reload(); }}>Switch player</button></div> : <form onSubmit={(event) => { event.preventDefault(); void signIn(); }}>
        {!newPlayer && <div className="club-player-list">{players.map((player) => <button type="button" className={username === player.displayName ? "is-selected" : ""} key={player.tag} onClick={() => { setUsername(player.displayName); setPassword(""); setError(""); }}><strong>{player.displayName}</strong><span>{player.tag}</span></button>)}</div>}
        <label>Player name<input value={username} maxLength={32} autoComplete="username" onChange={(event) => setUsername(event.target.value)} required /></label>
        {newPlayer ? <><label>Clash Royale tag<input value={tag} onChange={(event) => setTag(event.target.value)} placeholder="#YOURTAG" maxLength={16} required /></label><p className="club-account-hint">Your password will be your player name, exactly as written above.</p></> : <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder="Your player name, exactly as shown" required /></label>}
        {error && <p role="alert" className="club-account-error">{error}</p>}
        <button className="royale-button gold full-width" disabled={pending}>{pending ? "Connecting…" : newPlayer ? "Add player & sign in" : "Sign in & remember device"}</button>
        <p className="club-account-hint">Password = player name. This device stays signed in on this site address.</p>
        <button className="text-button" type="button" onClick={() => { setNewPlayer(!newPlayer); setUsername(newPlayer ? "PlayerOne" : ""); setPassword(""); setError(""); }}>{newPlayer ? "Back to existing players" : "Add another friend"}</button>
      </form>}
    </section></div>}
  </>;
}
