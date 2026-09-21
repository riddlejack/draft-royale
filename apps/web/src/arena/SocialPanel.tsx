import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Link, Swords, UserMinus, UserPlus, Users, WifiOff, X } from "lucide-react";
import { isChaosBattleMode, type ArenaCollection, type ArenaSettings, type SocialFriend, type SocialInvite } from "@draft-royale/shared";
import type { SocialController } from "./useSocial";
import { deviceHasAccount } from "./accounts/accountClient";
import "./social.css";

interface SocialPanelProps {
  social: SocialController;
  name: string;
  nameLocked?: boolean;
  onNameChange: (name: string) => void;
  settings: ArenaSettings;
  collection: ArenaCollection;
  friendToken: string;
  onFriendTokenChange: (token: string) => void;
  onAcceptInvite: (inviteId: string) => Promise<void>;
  onOpenInvite: (inviteId: string) => Promise<void>;
  onLegacyInvite: () => void;
  onClose: () => void;
  onCopy: (text: string, success: string) => Promise<void>;
}

const statusLabel: Record<SocialInvite["status"], string> = {
  pending: "Pending",
  accepted: "Accepted",
  declined: "Declined",
  canceled: "Canceled",
  expired: "Expired",
};

export function describeArenaSettings(settings: ArenaSettings) {
  const mode = settings.mode === "mega" ? "Mega Draft" : settings.mode === "triple" ? "Triple Draft" : "Classic Draft";
  const timer = `${settings.pickSeconds}s ${settings.timerMode === "whole_draft" ? "total" : "per pick"}`;
  const forms = settings.specialForms ? "Evolutions, Heroes & Champions" : "Classic cards";
  const grouped = settings.mode === "triple" && settings.specialForms && settings.groupedSpecialRounds ? " · Grouped special rounds" : "";
  const chaos = isChaosBattleMode(settings.battleMode) ? " · Chaos pool" : "";
  const customPool = settings.minElixir !== undefined || settings.maxElixir !== undefined || [settings.includeCards, settings.excludeCards, settings.cardKinds, settings.rarities, settings.families].some((items) => Boolean(items?.length)) ? " · Custom pool" : "";
  const mirror = settings.mirrorMode ? " · Mirror mode" : "";
  return `${mode} · ${settings.mode === "mega" ? `Up to ${settings.poolSize} cards · ` : ""}${timer} · ${forms} · ${settings.battleMode}${mirror}${grouped}${chaos}${customPool}`;
}

export function parseFriendLink(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed, window.location.origin);
    const token = new URLSearchParams(url.hash.slice(1)).get("friend");
    if (token) return token;
  } catch { /* A bare token is handled below. */ }
  const hashToken = new URLSearchParams(trimmed.replace(/^.*#/, "")).get("friend");
  if (hashToken) return hashToken;
  return /^[A-Za-z0-9_-]{43}$/.test(trimmed) ? trimmed : "";
}

const timeRemaining = (invite: SocialInvite, serverNow: number) => {
  if (invite.status !== "pending") return statusLabel[invite.status];
  const minutes = Math.max(0, Math.ceil((invite.expiresAt - serverNow) / 60_000));
  return minutes <= 1 ? "Expires in under a minute" : `Expires in ${minutes} min`;
};

export function SocialPanel({ social, name, nameLocked = false, onNameChange, settings, collection, friendToken, onFriendTokenChange, onAcceptInvite, onOpenInvite, onLegacyInvite, onClose, onCopy }: SocialPanelProps) {
  const [pastedLink, setPastedLink] = useState("");
  const [reviewedToken, setReviewedToken] = useState(friendToken);
  const [removeCandidate, setRemoveCandidate] = useState<SocialFriend | null>(null);
  const [panelNotice, setPanelNotice] = useState("");
  const incoming = social.state?.incomingInvites ?? [];
  const outgoing = social.state?.outgoingInvites ?? [];
  const pendingIncoming = incoming.filter((invite) => invite.status === "pending");
  const activeInvites = [...incoming.filter((invite) => invite.status === "pending" || invite.status === "accepted"), ...outgoing.filter((invite) => invite.status === "pending" || invite.status === "accepted")];
  const recentInvites = [...incoming, ...outgoing].filter((invite) => invite.status !== "pending" && invite.status !== "accepted").slice(0, 5);
  const pendingCount = pendingIncoming.length;
  const inviteBusy = (inviteId: string) => ["accept", "decline", "cancel", "open"].some((action) => social.isPending(`invite:${action}:${inviteId}`));
  const connectionBusy = Boolean(reviewedToken) && social.isPending(`friend-link:accept:${reviewedToken}`);
  const ownFriendUrl = useMemo(() => social.friendLink ? new URL(social.friendLink.path, window.location.origin).href : "", [social.friendLink]);

  useEffect(() => {
    setReviewedToken(friendToken);
  }, [friendToken]);

  useEffect(() => {
    if (!friendToken && social.status === "idle") void social.activate();
  }, [friendToken, social]);

  const acceptConnection = async () => {
    if (!reviewedToken) return;
    const accepted = await social.acceptFriendLink(reviewedToken);
    if (!accepted) return;
    setPanelNotice("Friend added. You can now send battle invitations.");
    setReviewedToken("");
    setPastedLink("");
    onFriendTokenChange("");
  };

  const challenge = async (friend: SocialFriend) => {
    if (await social.inviteFriend(friend.id, settings, collection)) setPanelNotice(`Battle invitation sent to ${friend.displayName}.`);
  };

  return <div className="arena-modal-backdrop" onClick={onClose}>
    <section className="arena-modal social-modal" role="dialog" aria-modal="true" aria-labelledby="social-title" onClick={(event) => event.stopPropagation()}>
      <header className="modal-heading"><div><h2 id="social-title">Friends</h2>{pendingCount > 0 && <span className="social-heading-badge">{pendingCount} new</span>}</div><button className="icon-button" onClick={onClose} aria-label="Close friends"><X /></button></header>

      <p className="social-privacy"><Users size={17} /> {nameLocked ? "Your friends belong to your account and follow you to any device you sign in on." : "Your friends stay here between visits. Use this same browser to find them, or sign in to keep them on every device."}</p>
      <label className="social-display-name">Your name<input value={name} maxLength={24} autoComplete="nickname" readOnly={nameLocked} title={nameLocked ? "Your name comes from the Clash Royale tag on your account." : undefined} onChange={(event) => onNameChange(event.target.value)} /></label>

      {social.status === "recovery" && <section className="social-recovery" role="alert">
        <WifiOff size={25} /><div><strong>Friend profile needs attention</strong><p>{social.error}</p></div>
        <div className="social-inline-actions"><button className="small-button" onClick={() => void social.retry()} disabled={social.isPending()}>{deviceHasAccount() ? "Try again" : "Retry saved profile"}</button>{deviceHasAccount()
          ? <button className="royale-button gold" onClick={() => { onClose(); window.dispatchEvent(new Event("draft-royale:sign-in")); }}>Sign in again</button>
          : <button className="text-button danger-text" onClick={() => void social.startNewProfile()} disabled={social.isPending()}>Start a new profile</button>}</div>
      </section>}

      {reviewedToken && social.status !== "recovery" && <section className="social-request" data-testid="friend-link-review">
        <UserPlus size={29} /><div><h3>Connect as friends?</h3><p>Accept once to let this person send you private battle invitations. They will also appear in your friends list.</p></div>
        <div className="social-inline-actions"><button className="royale-button gold" onClick={() => void acceptConnection()} disabled={connectionBusy}>Accept friend connection</button><button className="text-button" disabled={connectionBusy} onClick={() => { setReviewedToken(""); onFriendTokenChange(""); }}>Not now</button></div>
      </section>}

      {social.error && social.status !== "recovery" && <div className="social-error" role="alert"><span>{social.error}</span>{social.status === "offline" && <button className="small-button" onClick={() => void social.retry()}>Try again</button>}<button onClick={social.clearError} aria-label="Dismiss friends error">×</button></div>}
      {panelNotice && <div className="social-notice" role="status"><Check size={17} />{panelNotice}<button onClick={() => setPanelNotice("")} aria-label="Dismiss friends notice">×</button></div>}

      {social.status === "loading" && !social.state && <div className="social-loading" role="status">Restoring friends…</div>}

      {social.status !== "recovery" && social.state && <>
        <section className="social-section" aria-labelledby="friend-list-title">
          <div className="social-section-heading"><div><h3 id="friend-list-title">Choose a friend</h3><p>{describeArenaSettings(settings)}</p></div><span>{social.state.friends.length}</span></div>
          {social.state.friends.length === 0 ? <div className="social-empty"><Users size={31} /><strong>No friends here yet</strong><span>Create a one-time friend link below.</span></div> : <div className="social-list">{social.state.friends.map((friend) => <div className="social-row" data-testid="social-friend" key={friend.id}>
            <span className="social-avatar" aria-hidden="true">{friend.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{friend.displayName}</strong><small>Connected friend</small></div>
            <button className="small-button social-challenge" aria-label={`Challenge ${friend.displayName}`} disabled={social.isPending(`invite:create:${friend.id}`)} onClick={() => void challenge(friend)}><Swords size={15} /> Challenge</button>
            <button className="icon-button social-remove" aria-label={`Remove ${friend.displayName}`} onClick={() => setRemoveCandidate(friend)}><UserMinus size={16} /></button>
          </div>)}</div>}
        </section>

        {removeCandidate && <section className="social-confirm" role="alertdialog" aria-labelledby="remove-friend-title"><div><strong id="remove-friend-title">Remove {removeCandidate.displayName}?</strong><p>You would need a new friend link to reconnect.</p></div><div className="social-inline-actions"><button className="small-button danger-button" onClick={() => void social.removeFriend(removeCandidate.id).then((removed) => { if (removed) setRemoveCandidate(null); })}>Remove</button><button className="text-button" onClick={() => setRemoveCandidate(null)}>Keep friend</button></div></section>}

        <section className="social-section" aria-labelledby="inbox-title">
          <div className="social-section-heading"><div><h3 id="inbox-title">Battle invitations</h3><p>Invitations expire after 15 minutes.</p></div>{pendingCount > 0 && <span>{pendingCount} new</span>}</div>
          {activeInvites.length === 0 ? <p className="social-empty-line">No active invitations.</p> : <div className="social-list">{activeInvites.map((invite) => <article className={`social-invite ${invite.direction}`} data-testid="social-invite" key={`${invite.direction}:${invite.id}`}>
            <div className="social-invite-top"><span className="social-direction">{invite.direction === "incoming" ? "From" : "To"}</span><strong>{invite.friend.displayName}</strong><small>{timeRemaining(invite, social.state!.serverNow)}</small></div>
            <p>{describeArenaSettings(invite.settings)}</p>
            <div className="social-inline-actions">{invite.status === "pending" && invite.direction === "incoming" && <><button className="small-button accept-button" disabled={inviteBusy(invite.id)} onClick={() => void onAcceptInvite(invite.id)}>Accept & open room</button><button className="text-button" disabled={inviteBusy(invite.id)} onClick={() => void social.declineInvite(invite.id)}>Decline</button></>}{invite.status === "pending" && invite.direction === "outgoing" && <button className="text-button danger-text" disabled={inviteBusy(invite.id)} onClick={() => void social.cancelInvite(invite.id)}>Cancel invitation</button>}{invite.status === "accepted" && <button className="small-button" disabled={inviteBusy(invite.id)} onClick={() => void onOpenInvite(invite.id)}>Open battle room</button>}</div>
          </article>)}</div>}
          {recentInvites.length > 0 && <details className="social-history"><summary>Recent invitations</summary>{recentInvites.map((invite) => <div key={`${invite.direction}:${invite.id}`}><span>{invite.friend.displayName}</span><small>{statusLabel[invite.status]}</small></div>)}</details>}
        </section>

        <section className="social-section social-link-section" aria-labelledby="friend-link-title">
          <div className="social-section-heading"><div><h3 id="friend-link-title">Add a friend</h3><p>Each friend link works once and expires in 7 days.</p></div></div>
          {!social.friendLink ? <button className="small-button full-width" disabled={social.isPending("friend-link:create")} onClick={() => void social.createFriendLink()}><UserPlus size={16} /> Create my friend link</button> : <div className="social-link-ready"><label className="social-link-output">Your friend link<div><input readOnly value={ownFriendUrl} onFocus={(event) => event.currentTarget.select()} /><button className="small-button" aria-label="Copy your friend link" onClick={() => void onCopy(ownFriendUrl, "Friend link copied.")}><Copy size={16} /> Copy</button></div></label><button className="text-button" disabled={social.isPending("friend-link:create")} onClick={() => void social.createFriendLink()}><UserPlus size={14} /> Create new friend link</button></div>}
          <form className="social-paste" onSubmit={(event) => { event.preventDefault(); const token = parseFriendLink(pastedLink); if (token) { setReviewedToken(token); onFriendTokenChange(token); social.clearError(); } else setPanelNotice("Paste a complete friend link or its 43-character token."); }}><label>Paste a friend link<input value={pastedLink} onChange={(event) => setPastedLink(event.target.value)} placeholder="https://…/#friend=…" autoComplete="off" /></label><button className="small-button" disabled={!pastedLink.trim()}><Link size={15} /> Review link</button></form>
        </section>
      </>}

      {social.status === "idle" && !reviewedToken && <button className="royale-button gold full-width" onClick={() => void social.activate()}>Open my friends</button>}
      <div className="social-legacy"><span>Inviting someone new for one draft?</span><button className="text-button" onClick={onLegacyInvite}><Link size={15} /> Invite by link or room code</button></div>
    </section>
  </div>;
}
