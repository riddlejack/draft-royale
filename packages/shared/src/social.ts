import type { ArenaCollection, ArenaSessionResponse, ArenaSettings } from "./arena.js";

export type SocialInviteStatus = "pending" | "accepted" | "declined" | "canceled" | "expired";
export type SocialInviteDirection = "incoming" | "outgoing";

export interface SocialProfile {
  id: string;
  displayName: string;
  createdAt: number;
}

export interface SocialCredential {
  profileId: string;
  token: string;
}

export interface SocialFriend {
  id: string;
  displayName: string;
  since: number;
}

export interface SocialInvite {
  id: string;
  direction: SocialInviteDirection;
  status: SocialInviteStatus;
  friend: Pick<SocialProfile, "id" | "displayName">;
  settings: ArenaSettings;
  createdAt: number;
  expiresAt: number;
  respondedAt: number | null;
  roomId?: string;
}

export interface SocialState {
  profile: SocialProfile;
  friends: SocialFriend[];
  incomingInvites: SocialInvite[];
  outgoingInvites: SocialInvite[];
  serverNow: number;
}

export interface SocialFriendLink {
  token: string;
  path: string;
  expiresAt: number;
}

export interface SocialProfileResponse {
  credential: SocialCredential;
  state: SocialState;
}

export interface SocialStateResponse {
  state: SocialState;
}

export interface SocialFriendLinkResponse {
  friendLink: SocialFriendLink;
}

export interface SocialFriendResponse {
  friend: SocialFriend;
  state: SocialState;
}

export interface SocialInviteResponse {
  invite: SocialInvite;
  state: SocialState;
}

export interface SocialInviteSessionResponse extends SocialInviteResponse {
  session: ArenaSessionResponse;
}

export interface SocialSessionResponse {
  invite: SocialInvite;
  session: ArenaSessionResponse;
}

export interface CreateSocialProfileInput {
  displayName: string;
  /** Browser-generated 32-byte base64url credential. Reusing it safely resumes a lost create response. */
  credentialToken?: string;
}

export interface UpdateSocialProfileInput {
  displayName: string;
  commandId: string;
}

export interface CreateFriendLinkInput {
  commandId: string;
}

export interface AcceptFriendLinkInput {
  token: string;
  commandId: string;
}

export interface CreateSocialInviteInput {
  friendId: string;
  settings: ArenaSettings;
  collection?: ArenaCollection;
  commandId: string;
}

export interface RespondSocialInviteInput {
  collection?: ArenaCollection;
  commandId: string;
}

export interface SocialCommandInput {
  commandId: string;
}
