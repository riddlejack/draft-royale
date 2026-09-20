import type { DeckDefinition } from "./decks.js";

export type MirrorRoomSeat = "a" | "b";
export type MirrorPlaylistKey = "mirror" | "classics" | "community";
export type MirrorRoomAction = "next" | "previous" | "shuffle" | "edit" | "playlist";

export interface MirrorRoomCredential {
  roomId: string;
  seat: MirrorRoomSeat;
  token: string;
}

export interface MirrorPlaylistSummary {
  id: MirrorPlaylistKey;
  label: string;
  count: number;
  description: string;
}

/** Viewer-safe synchronized deck state. Opaque credentials are returned separately. */
export interface MirrorRoomView {
  id: string;
  code: string;
  revision: number;
  viewer: MirrorRoomSeat;
  hostName: string;
  guestName: string | null;
  playlist: MirrorPlaylistKey;
  availablePlaylists: MirrorPlaylistSummary[];
  deck: DeckDefinition;
  /** Zero-based position in the active playlist, or -1 for a custom deck. */
  index: number;
  playlistCount: number;
  historyIndex: number;
  historyCount: number;
  canGoPrevious: boolean;
  canGoForward: boolean;
  canEdit: boolean;
  updatedAt: number;
  serverNow: number;
}

export interface MirrorRoomSessionResponse {
  credential: MirrorRoomCredential;
  room: MirrorRoomView;
}

export type MirrorRoomCommand = {
  action: "next" | "previous" | "shuffle";
  expectedRevision: number;
  commandId: string;
} | {
  action: "edit";
  expectedRevision: number;
  commandId: string;
  deck: DeckDefinition;
} | {
  action: "playlist";
  expectedRevision: number;
  commandId: string;
  playlist: MirrorPlaylistKey;
};
