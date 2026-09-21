import { useCallback, useEffect, useRef, useState } from "react";
import type { ArenaCollection, ArenaSessionResponse, ArenaSettings, SocialCredential, SocialFriendLink, SocialState } from "@draft-royale/shared";
import { deviceHasAccount } from "./accounts/accountClient";
import {
  SOCIAL_IDENTITY_STORAGE_KEY,
  SocialApiError,
  acceptSocialFriendLink,
  acceptSocialInvite,
  bootstrapSocialProfile,
  cancelSocialInvite,
  clearSocialIdentity,
  createSocialFriendLink,
  createSocialInvite,
  declineSocialInvite,
  getSocialInviteSession,
  getSocialState,
  inspectStoredSocialIdentity,
  parseStoredSocialIdentity,
  readSocialIdentity,
  removeSocialFriend,
  socialCommandId,
  updateSocialProfile,
  type StoredSocialIdentity,
} from "./socialClient";

export type SocialConnectionStatus = "idle" | "loading" | "ready" | "offline" | "recovery";

const messageOf = (error: unknown) => error instanceof Error ? error.message : "Friends could not connect. Please try again.";
const credentialOf = (identity: StoredSocialIdentity | null): SocialCredential | null => identity?.profileId ? { profileId: identity.profileId, token: identity.token } : null;

export interface SocialController {
  identity: SocialCredential | null;
  state: SocialState | null;
  status: SocialConnectionStatus;
  error: string;
  friendLink: SocialFriendLink | null;
  isPending: (key?: string) => boolean;
  activate: () => Promise<SocialCredential | null>;
  retry: () => Promise<void>;
  startNewProfile: () => Promise<void>;
  clearError: () => void;
  createFriendLink: () => Promise<SocialFriendLink | undefined>;
  acceptFriendLink: (token: string) => Promise<boolean>;
  removeFriend: (friendId: string) => Promise<boolean>;
  inviteFriend: (friendId: string, settings: ArenaSettings, collection: ArenaCollection) => Promise<boolean>;
  acceptInvite: (inviteId: string, collection: ArenaCollection) => Promise<ArenaSessionResponse | undefined>;
  declineInvite: (inviteId: string) => Promise<boolean>;
  cancelInvite: (inviteId: string) => Promise<boolean>;
  openInvite: (inviteId: string, quiet?: boolean) => Promise<ArenaSessionResponse | undefined>;
}

export function useSocial(displayName: string): SocialController {
  const initialInspection = useRef(inspectStoredSocialIdentity());
  const initialIdentity = useRef(initialInspection.current.identity);
  const identityRef = useRef<StoredSocialIdentity | null>(initialIdentity.current);
  const identityRevisionRef = useRef(0);
  const stateRef = useRef<SocialState | null>(null);
  const displayNameRef = useRef(displayName);
  const activationRef = useRef<Promise<SocialCredential | null> | null>(null);
  const pendingRef = useRef(new Set<string>());
  const refreshRef = useRef<(quiet?: boolean) => Promise<void>>(async () => undefined);
  const recoveryRef = useRef(initialInspection.current.status === "malformed" || initialInspection.current.status === "unavailable");
  const [identity, setIdentity] = useState<SocialCredential | null>(() => credentialOf(initialIdentity.current));
  const [state, setState] = useState<SocialState | null>(null);
  const initialIdentityProblem = initialInspection.current.status === "malformed" || initialInspection.current.status === "unavailable";
  const [status, setStatus] = useState<SocialConnectionStatus>(initialIdentityProblem ? "recovery" : initialIdentity.current ? "loading" : "idle");
  const [error, setError] = useState(initialInspection.current.status === "malformed" ? "This browser's saved friend profile is damaged. Start a new profile to replace it." : initialInspection.current.status === "unavailable" ? "Friends are unavailable because this browser blocks profile storage. Practice and room links still work." : "");
  const [friendLink, setFriendLink] = useState<SocialFriendLink | null>(null);
  const [, setPendingRevision] = useState(0);
  const [identitySignal, setIdentitySignal] = useState(0);

  displayNameRef.current = displayName;

  const selectIdentity = useCallback((next: StoredSocialIdentity | null) => {
    identityRevisionRef.current += 1;
    recoveryRef.current = false;
    identityRef.current = next;
    stateRef.current = null;
    setIdentity(credentialOf(next));
    setState(null);
    setFriendLink(null);
    setIdentitySignal((value) => value + 1);
    setStatus(next ? "loading" : "idle");
    setError("");
  }, []);

  const applyState = useCallback((next: SocialState, token: string) => {
    if (identityRef.current?.token !== token) return false;
    if (stateRef.current && next.serverNow < stateRef.current.serverNow) return false;
    stateRef.current = next;
    recoveryRef.current = false;
    setState(next);
    setStatus("ready");
    setError("");
    return true;
  }, []);

  const handleFailure = useCallback((failure: unknown, quiet = false) => {
    if (failure instanceof SocialApiError && failure.status === 401) {
      recoveryRef.current = true;
      setStatus("recovery");
      setError(deviceHasAccount()
        ? "Your sign-in on this device has ended. Sign in again to see your friends."
        : "This browser's saved friend profile could not be restored. Retry it or start a new profile.");
      return;
    }
    setStatus((current) => current === "ready" && navigator.onLine ? current : "offline");
    if (!quiet) setError(messageOf(failure));
  }, []);

  const establish = useCallback(async () => {
    const identityRevision = identityRevisionRef.current;
    setStatus("loading");
    try {
      const result = await bootstrapSocialProfile(displayNameRef.current.trim() || "Player");
      if (identityRevisionRef.current !== identityRevision) return credentialOf(identityRef.current);
      const stored = readSocialIdentity();
      if (!stored || stored.token !== result.credential.token) return credentialOf(stored);
      identityRef.current = stored;
      setIdentity(result.credential);
      applyState(result.state, stored.token);
      return result.credential;
    } catch (failure) {
      if (identityRevisionRef.current === identityRevision) handleFailure(failure);
      return null;
    }
  }, [applyState, handleFailure]);

  const activate = useCallback(() => {
    const current = credentialOf(identityRef.current);
    if (current) return Promise.resolve(current);
    if (activationRef.current) return activationRef.current;
    const task = establish().finally(() => { if (activationRef.current === task) activationRef.current = null; });
    activationRef.current = task;
    return task;
  }, [establish]);

  const ensureCredential = useCallback(async () => credentialOf(identityRef.current) ?? activate(), [activate]);

  const setPending = useCallback((key: string, value: boolean) => {
    if (value) pendingRef.current.add(key); else pendingRef.current.delete(key);
    setPendingRevision((revision) => revision + 1);
  }, []);

  const execute = useCallback(async <T,>(key: string, action: (stored: StoredSocialIdentity) => Promise<T>, options: { quiet?: boolean } = {}): Promise<T | undefined> => {
    if (pendingRef.current.has(key)) return undefined;
    setPending(key, true);
    setError("");
    let requestToken: string | undefined;
    try {
      const active = await ensureCredential();
      const stored = identityRef.current;
      if (!active || !stored?.profileId || stored.token !== active.token) return undefined;
      requestToken = stored.token;
      const result = await action(stored);
      if (identityRef.current?.token !== requestToken) return undefined;
      setStatus("ready");
      return result;
    } catch (failure) {
      if (requestToken && identityRef.current?.token !== requestToken) return undefined;
      // Only the identity check may declare the saved sign-in broken. One action answering 401
      // (a stale room, a proxy hiccup) must never hide the friends list or offer to replace the profile.
      if (requestToken && failure instanceof SocialApiError && failure.status === 401) {
        if (!options.quiet) setError(messageOf(failure));
        await refreshRef.current(true);
      } else handleFailure(failure, options.quiet);
      return undefined;
    } finally {
      setPending(key, false);
    }
  }, [ensureCredential, handleFailure, setPending]);

  const refresh = useCallback(async (quiet = false) => {
    const stored = identityRef.current;
    if (!stored?.profileId || pendingRef.current.has("refresh")) return;
    setPending("refresh", true);
    const requestToken = stored.token;
    try {
      const next = await getSocialState(stored);
      applyState(next, stored.token);
    } catch (failure) {
      if (identityRef.current?.token === requestToken) handleFailure(failure, quiet && stateRef.current !== null);
    } finally {
      setPending("refresh", false);
    }
  }, [applyState, handleFailure, setPending]);
  refreshRef.current = refresh;

  useEffect(() => {
    const current = identityRef.current;
    if (!current) return;
    if (!current.profileId) { void activate(); return; }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (disposed) return;
      if (document.visibilityState === "visible" && !recoveryRef.current) await refresh(true);
      if (!disposed) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    const wake = () => { if (document.visibilityState === "visible") void refresh(true); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", wake); window.removeEventListener("online", wake); };
  }, [activate, identity?.profileId, identity?.token, identitySignal, refresh]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SOCIAL_IDENTITY_STORAGE_KEY) return;
      const next = parseStoredSocialIdentity(event.newValue);
      const current = identityRef.current;
      if (next?.token === current?.token && next?.profileId === current?.profileId) return;
      // The stored identity is the winner. Never rewrite a stale tab's token over it.
      selectIdentity(next);
      if (next && !next.profileId) {
        const previousActivation = activationRef.current;
        void (previousActivation ?? Promise.resolve(null)).finally(() => {
          if (identityRef.current?.token === next.token && !identityRef.current.profileId) void activate();
        });
      }
      if (event.newValue !== null && !next) {
        recoveryRef.current = true;
        setStatus("recovery");
        setError("This browser's saved friend profile is damaged. Start a new profile to replace it.");
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [activate, selectIdentity]);

  const retry = useCallback(async () => {
    recoveryRef.current = false;
    setError("");
    const stored = identityRef.current;
    if (stored?.profileId) await refresh(false); else await activate();
  }, [activate, refresh]);

  const startNewProfile = useCallback(async () => {
    if (pendingRef.current.size > 0) return;
    // Replacing the stored identity would sign an account out, so an account device signs in again instead.
    if (deviceHasAccount()) { window.dispatchEvent(new Event("draft-royale:sign-in")); return; }
    setPending("new-profile", true);
    try {
      clearSocialIdentity();
      selectIdentity(null);
      await activate();
    } catch (failure) {
      handleFailure(failure);
    } finally {
      setPending("new-profile", false);
    }
  }, [activate, handleFailure, selectIdentity, setPending]);

  const createFriendLink = useCallback(async () => {
    const commandId = socialCommandId();
    const response = await execute("friend-link:create", async (stored) => {
      const currentState = stateRef.current;
      const nextName = displayNameRef.current.trim() || "Player";
      if (!currentState || currentState.profile.displayName !== nextName) {
        const renamed = await updateSocialProfile(stored, { displayName: nextName, commandId: socialCommandId() });
        applyState(renamed.state, stored.token);
      }
      return createSocialFriendLink(stored, { commandId });
    });
    if (response) setFriendLink(response.friendLink);
    return response?.friendLink;
  }, [applyState, execute]);

  const acceptFriendLink = useCallback(async (token: string) => {
    const commandId = socialCommandId();
    const response = await execute(`friend-link:accept:${token}`, async (stored) => {
      const currentState = stateRef.current;
      const nextName = displayNameRef.current.trim() || "Player";
      if (!currentState || currentState.profile.displayName !== nextName) {
        const renamed = await updateSocialProfile(stored, { displayName: nextName, commandId: socialCommandId() });
        applyState(renamed.state, stored.token);
      }
      return acceptSocialFriendLink(stored, { token, commandId });
    });
    if (!response) return false;
    applyState(response.state, identityRef.current?.token ?? "");
    return true;
  }, [applyState, execute]);

  const removeFriend = useCallback(async (friendId: string) => {
    const commandId = socialCommandId();
    const response = await execute(`friend:remove:${friendId}`, (stored) => removeSocialFriend(stored, friendId, { commandId }));
    if (!response) return false;
    applyState(response.state, identityRef.current?.token ?? "");
    return true;
  }, [applyState, execute]);

  const inviteFriend = useCallback(async (friendId: string, settings: ArenaSettings, collection: ArenaCollection) => {
    const response = await execute(`invite:create:${friendId}`, async (stored) => {
      const currentState = stateRef.current;
      const nextName = displayNameRef.current.trim() || "Player";
      if (!currentState || currentState.profile.displayName !== nextName) {
        const renamed = await updateSocialProfile(stored, { displayName: nextName, commandId: socialCommandId() });
        applyState(renamed.state, stored.token);
      }
      return createSocialInvite(stored, { friendId, settings, collection, commandId: socialCommandId() });
    });
    if (!response) return false;
    applyState(response.state, identityRef.current?.token ?? "");
    return true;
  }, [applyState, execute]);

  const acceptInvite = useCallback(async (inviteId: string, collection: ArenaCollection) => {
    const commandId = socialCommandId();
    const response = await execute(`invite:accept:${inviteId}`, (stored) => acceptSocialInvite(stored, inviteId, { collection, commandId }));
    if (!response) return undefined;
    applyState(response.state, identityRef.current?.token ?? "");
    return response.session;
  }, [applyState, execute]);

  const declineInvite = useCallback(async (inviteId: string) => {
    const commandId = socialCommandId();
    const response = await execute(`invite:decline:${inviteId}`, (stored) => declineSocialInvite(stored, inviteId, { commandId }));
    if (!response) return false;
    applyState(response.state, identityRef.current?.token ?? "");
    return true;
  }, [applyState, execute]);

  const cancelInvite = useCallback(async (inviteId: string) => {
    const commandId = socialCommandId();
    const response = await execute(`invite:cancel:${inviteId}`, (stored) => cancelSocialInvite(stored, inviteId, { commandId }));
    if (!response) return false;
    applyState(response.state, identityRef.current?.token ?? "");
    return true;
  }, [applyState, execute]);

  const openInvite = useCallback(async (inviteId: string, quiet = false) => {
    const response = await execute(`invite:open:${inviteId}`, (stored) => getSocialInviteSession(stored, inviteId), { quiet });
    return response?.session;
  }, [execute]);

  return {
    identity, state, status, error, friendLink,
    isPending: (key) => key ? pendingRef.current.has(key) : pendingRef.current.size > 0,
    activate, retry, startNewProfile, clearError: () => setError(""),
    createFriendLink, acceptFriendLink, removeFriend, inviteFriend, acceptInvite, declineInvite, cancelInvite, openInvite,
  };
}
