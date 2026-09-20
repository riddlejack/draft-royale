import { useCallback, useEffect, useRef, useState } from "react";
import type { ArenaCollection } from "@draft-royale/shared";
import { Check, KeyRound, LogIn, RefreshCw, ShieldCheck, UserRound, X } from "lucide-react";
import { clearSocialIdentity, readSocialIdentity, writeSocialIdentity } from "../socialClient";
import { storage } from "../client";
import {
  AccountApiError,
  createGoogleChallenge,
  finishGoogleSignIn,
  forgetAccount,
  getAccountSession,
  getProviderConfig,
  importAccountCollection,
  loginAccount,
  logoutAccount,
  recoverAccount,
  registerAccount,
  rotateAccountRecovery,
  rememberAccount,
  rememberedAccount,
  updateAccountTag,
  type AccountSession,
  type ClubAccount,
  type ProviderConfig,
} from "./accountClient";
import "./accounts.css";

type GoogleApi = {
  accounts: { id: {
    initialize(input: { client_id: string; nonce: string; callback: (response: { credential?: string }) => void; auto_select: boolean; cancel_on_tap_outside: boolean }): void;
    renderButton(element: HTMLElement, options: { theme: string; size: string; shape: string; text: string; width: number }): void;
  } };
};
declare global { interface Window { google?: GoogleApi } }

let googleScript: Promise<void> | null = null;
const loadGoogleScript = () => {
  if (window.google?.accounts.id) return Promise.resolve();
  if (googleScript) return googleScript;
  googleScript = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => window.google?.accounts.id ? resolve() : reject(new Error("Google sign-in did not initialize."));
    script.onerror = () => reject(new Error("Google sign-in could not load."));
    document.head.appendChild(script);
  }).catch((error) => { googleScript = null; throw error; });
  return googleScript;
};

function GoogleSignIn({ clientId, linkToken, onSession, onError }: {
  clientId: string;
  linkToken?: string;
  onSession: (session: AccountSession) => void;
  onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [preparing, setPreparing] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setPreparing(true);
    void Promise.all([loadGoogleScript(), createGoogleChallenge()]).then(([, challenge]) => {
      if (cancelled || !host.current || !window.google) return;
      host.current.replaceChildren();
      window.google.accounts.id.initialize({
        client_id: clientId,
        nonce: challenge.nonce,
        auto_select: false,
        cancel_on_tap_outside: true,
        callback: ({ credential }) => {
          if (!credential) { onError("Google did not return a sign-in credential."); setAttempt((value) => value + 1); return; }
          void finishGoogleSignIn(credential, challenge.state, linkToken).then(onSession).catch((failure: unknown) => {
            onError(failure instanceof Error ? failure.message : "Google sign-in failed.");
            setAttempt((value) => value + 1);
          });
        },
      });
      window.google.accounts.id.renderButton(host.current, {
        theme: "filled_blue", size: "large", shape: "pill", text: linkToken ? "continue_with" : "signin_with", width: 280,
      });
      setPreparing(false);
    }).catch((failure: unknown) => {
      setPreparing(false);
      onError(failure instanceof Error ? failure.message : "Google sign-in is unavailable.");
    });
    return () => { cancelled = true; };
  }, [attempt, clientId, linkToken, onError, onSession]);
  return <div className="club-google-slot">{preparing ? <span>Preparing secure Google sign-in…</span> : null}<div ref={host} /></div>;
}

export function AccountButton() {
  const account = rememberedAccount();
  return <button className="small-button account-button" onClick={() => window.dispatchEvent(new Event("draft-royale:sign-in"))}>{account ? <UserRound size={16} /> : <LogIn size={16} />}<span>{account?.displayName ?? "Sign in"}</span></button>;
}

export function AccountControl({ hideTrigger = false, onSession, onCollection }: {
  hideTrigger?: boolean;
  onSession?: (session: AccountSession) => void;
  onCollection?: (collection: ArenaCollection, account: ClubAccount) => void;
}) {
  const [account, setAccount] = useState(rememberedAccount);
  const [providers, setProviders] = useState<ProviderConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"login" | "register" | "recover">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [claimRequired, setClaimRequired] = useState(false);
  const [tag, setTag] = useState(account?.tag ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newRecoveryCode, setNewRecoveryCode] = useState("");
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [showRecoveryRotation, setShowRecoveryRotation] = useState(false);

  const acceptSession = useCallback((session: AccountSession, reload = false) => {
    if (!session.credential?.token || session.account.profileId !== session.credential.profileId) throw new Error("The account response was incomplete.");
    const previous = readSocialIdentity();
    if (previous?.profileId && previous.profileId !== session.credential.profileId) {
      try { localStorage.setItem(`draft-royale:previous-profile:${previous.profileId}`, JSON.stringify(previous)); } catch { /* Best effort. */ }
    }
    writeSocialIdentity(session.credential);
    rememberAccount(session.account);
    storage.set("name", session.account.displayName);
    setAccount(session.account);
    setTag(session.account.tag ?? "");
    onSession?.(session);
    if (session.recoveryCode) setNewRecoveryCode(session.recoveryCode);
    else if (reload) window.location.reload();
  }, [onSession]);

  useEffect(() => {
    const identity = readSocialIdentity();
    if (!identity?.profileId) return;
    void getAccountSession(identity.token).then((session) => {
      setAccount(session.account); setTag(session.account.tag ?? ""); rememberAccount(session.account); onSession?.(session);
    }).catch((failure: unknown) => {
      if (failure instanceof AccountApiError && failure.status === 401) { forgetAccount(); setAccount(null); }
    });
  }, [onSession]);
  useEffect(() => {
    void getProviderConfig().then(setProviders).catch(() => setProviders({ google: { enabled: false }, apple: { enabled: false } }));
  }, []);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("draft-royale:sign-in", show);
    return () => window.removeEventListener("draft-royale:sign-in", show);
  }, []);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !newRecoveryCode) setOpen(false); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [newRecoveryCode, open]);

  const googleSession = useCallback((session: AccountSession) => {
    try { acceptSession(session, !account); setNotice(account ? "Google sign-in connected." : "Signed in with Google."); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Google sign-in failed."); }
  }, [acceptSession, account]);

  async function submitCredentials() {
    if (pending) return;
    if ((mode === "register" || mode === "recover") && password !== passwordConfirm) { setError("Passwords do not match."); return; }
    setPending(true); setError(""); setNotice("");
    try {
      const session = mode === "register" ? await registerAccount(username, password, resetCode)
        : mode === "recover" ? await recoverAccount(username, recoveryCode, password)
          : await loginAccount(username, password);
      acceptSession(session, true);
    } catch (failure) {
      const code = failure && typeof failure === "object" && "code" in failure ? failure.code : undefined;
      if (code === "ACCOUNT_CLAIM_REQUIRED") setClaimRequired(true);
      setError(failure instanceof Error ? failure.message : "Unable to sign in. Try again.");
    }
    finally { setPending(false); }
  }

  async function saveTag(value: string | null) {
    const identity = readSocialIdentity();
    if (!identity?.token) return;
    setPending(true); setError(""); setNotice("");
    try {
      const result = await updateAccountTag(identity.token, value);
      setAccount(result.account); setTag(result.account.tag ?? ""); rememberAccount(result.account);
      setNotice(result.account.tag ? "Player tag saved. Import your cards next." : "Tracked player tag removed. Your saved collection is unchanged.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not save the player tag."); }
    finally { setPending(false); }
  }

  async function importCollection() {
    const identity = readSocialIdentity();
    if (!identity?.token || !account) return;
    setPending(true); setError(""); setNotice("");
    try {
      const imported = await importAccountCollection(identity.token);
      onCollection?.(imported.collection, account);
      setNotice(imported.stale ? "Clash Royale is unavailable, so your last successful import was kept." : `${imported.collection.cards?.length ?? 0} cards imported and saved to this account.`);
    } catch (failure) { setError(failure instanceof Error ? `${failure.message} Your saved collection was not changed.` : "Collection import failed. Your saved collection was not changed."); }
    finally { setPending(false); }
  }

  async function signOut() {
    const identity = readSocialIdentity();
    if (!identity?.token) return;
    setPending(true); setError("");
    try {
      await logoutAccount(identity.token);
      clearSocialIdentity(); forgetAccount(); storage.set("name", "Player"); window.location.reload();
    } catch (failure) {
      if (failure instanceof AccountApiError && failure.status === 401) {
        clearSocialIdentity(); forgetAccount(); storage.set("name", "Player"); window.location.reload(); return;
      }
      setError(failure instanceof Error ? `${failure.message} This device stayed signed in because the server could not confirm revocation.` : "Could not confirm sign out. This device stayed signed in.");
      setPending(false);
    }
  }

  async function rotateRecovery() {
    const identity = readSocialIdentity();
    if (!identity?.token) return;
    setPending(true); setError("");
    try {
      const result = await rotateAccountRecovery(identity.token, recoveryPassword);
      setRecoveryPassword(""); setShowRecoveryRotation(false); setNewRecoveryCode(result.recoveryCode);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not replace the recovery code."); }
    finally { setPending(false); }
  }

  const switchMode = (next: typeof mode) => {
    setMode(next); setUsername(""); setPassword(""); setPasswordConfirm(""); setRecoveryCode(""); setResetCode(""); setClaimRequired(false); setError(""); setNotice("");
  };

  return <>
    {!hideTrigger ? <button className="small-button account-button" onClick={() => setOpen(true)}>{account ? <UserRound size={16} /> : <LogIn size={16} />}<span>{account?.displayName ?? "Sign in"}</span></button> : null}
    {open ? <div className="club-account-backdrop" onClick={() => { if (!newRecoveryCode) setOpen(false); }}><section className="club-account-panel" role="dialog" aria-modal="true" aria-label="Draft Royale account" onClick={(event) => event.stopPropagation()}>
      <header><div><span className="club-eyebrow">DRAFT ROYALE</span><h2>{newRecoveryCode ? "Save your recovery code" : account ? account.displayName : mode === "register" ? "Create your account" : mode === "recover" ? "Recover your account" : "Sign in"}</h2></div>{!newRecoveryCode ? <button className="icon-button" onClick={() => setOpen(false)} aria-label="Close sign in"><X /></button> : null}</header>
      {newRecoveryCode ? <div className="club-recovery-card"><KeyRound /><div><strong>This is shown once</strong><p>Save this code somewhere private. It can reset your password if you lose access; using it replaces the code and signs out other devices.</p><code>{newRecoveryCode}</code></div><button className="royale-button gold full-width" onClick={() => window.location.reload()}><Check size={18} /> I saved it — continue</button></div>
        : account ? <div className="club-account-current">
          <div className="club-session-ok"><ShieldCheck size={18} /><span>Signed in on this device</span></div>
          <p>Your private decks, friends, collection, and match records belong to this Draft Royale profile—not to a public player tag.</p>
          <div className="club-tag-editor"><label>Tracked Clash Royale tag<input value={tag} onChange={(event) => setTag(event.target.value.toUpperCase())} placeholder="#YOURTAG" maxLength={16} /></label><div><button className="royale-button blue" disabled={pending || !tag.trim()} onClick={() => void saveTag(tag)}>Save tag</button>{account.tag ? <button className="text-button" disabled={pending} onClick={() => void saveTag(null)}>Remove</button> : null}</div></div>
          {account.tag ? <button className="royale-button gold full-width" disabled={pending} onClick={() => void importCollection()}><RefreshCw size={18} /> {pending ? "Importing…" : "Import profile collection"}</button> : <p className="club-account-hint">Add a public tag, then import the full profile inventory. More than one Draft Royale account may track the same tag.</p>}
          {providers?.google.enabled && providers.google.clientId && !account.providers.includes("google") ? <div className="club-provider-link"><span>Optional faster sign-in</span><GoogleSignIn clientId={providers.google.clientId} linkToken={readSocialIdentity()?.token} onSession={googleSession} onError={setError} /></div> : null}
          {account.providers.includes("google") ? <p className="club-connected"><Check size={15} /> Google sign-in connected</p> : null}
          {account.passwordEnabled ? <div className="club-recovery-rotate">{showRecoveryRotation ? <><label>Current password<input type="password" value={recoveryPassword} onChange={(event) => setRecoveryPassword(event.target.value)} autoComplete="current-password" /></label><div><button className="royale-button blue" disabled={pending || !recoveryPassword} onClick={() => void rotateRecovery()}>Create new code</button><button className="text-button" disabled={pending} onClick={() => { setShowRecoveryRotation(false); setRecoveryPassword(""); }}>Cancel</button></div></> : <button className="text-button" onClick={() => setShowRecoveryRotation(true)}>Replace recovery code</button>}</div> : null}
          {notice ? <p className="club-account-notice" role="status">{notice}</p> : null}
          {error ? <p role="alert" className="club-account-error">{error}</p> : null}
          <button className="text-button club-sign-out" disabled={pending} onClick={() => void signOut()}>Sign out of this device</button>
        </div> : <>
          {mode === "login" && providers?.google.enabled && providers.google.clientId ? <><GoogleSignIn clientId={providers.google.clientId} onSession={googleSession} onError={setError} /><p className="club-account-hint">New here? Google creates your Draft Royale profile. Already have a player-name account? Sign in below once, then connect Google from your account panel.</p><div className="club-divider"><span>or use your Draft Royale account</span></div></> : null}
          <form onSubmit={(event) => { event.preventDefault(); void submitCredentials(); }}>
            <label>Player name<input value={username} maxLength={32} autoComplete="username" onChange={(event) => setUsername(event.target.value)} required /></label>
            {mode === "recover" ? <label>Recovery code<input value={recoveryCode} maxLength={40} autoComplete="off" onChange={(event) => setRecoveryCode(event.target.value.toUpperCase())} placeholder="DR-…" required /></label> : null}
            {mode === "register" && claimRequired ? <label>One-time reset code<input value={resetCode} maxLength={100} autoComplete="off" onChange={(event) => setResetCode(event.target.value.toUpperCase())} placeholder="DR-RESET-…" required /></label> : null}
            <label>{mode === "recover" ? "New password" : "Password"}<input type="password" minLength={mode === "login" ? undefined : 12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder={mode === "login" ? "Password" : "12 characters or more"} required /></label>
            {mode !== "login" ? <label>Confirm password<input type="password" minLength={12} maxLength={128} value={passwordConfirm} onChange={(event) => setPasswordConfirm(event.target.value)} autoComplete="new-password" required /></label> : null}
            {error ? <p role="alert" className="club-account-error">{error}</p> : null}
            <button className="royale-button gold full-width" disabled={pending}>{pending ? "Connecting…" : mode === "register" ? "Create account" : mode === "recover" ? "Reset password & sign in" : "Sign in & remember device"}</button>
            <p className="club-account-hint">Use a unique Draft Royale password. Never enter a Supercell password or email code here.</p>
            <div className="club-mode-links">{mode !== "login" ? <button className="text-button" type="button" onClick={() => switchMode("login")}>Back to sign in</button> : <><button className="text-button" type="button" onClick={() => switchMode("register")}>Create account</button><button className="text-button" type="button" onClick={() => switchMode("recover")}>Use recovery code</button></>}</div>
          </form>
        </>}
    </section></div> : null}
  </>;
}
