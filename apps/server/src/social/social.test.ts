import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Express } from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { ArenaCard, SocialProfileResponse } from "@draft-royale/shared";
import { createArenaApp } from "../arena/index.js";
import type { ArenaService } from "../arena/service.js";
import { deriveSocialRoomToken, SOCIAL_FRIEND_LINK_TTL_MS, SOCIAL_INVITE_TTL_MS } from "./service.js";

const catalog: ArenaCard[] = Array.from({ length: 64 }, (_, index) => ({
  key: `card-${index + 1}`,
  id: 26_000_000 + index,
  name: `Card ${index + 1}`,
  elixir: (index % 9) + 1,
  rarity: index % 2 ? "rare" : "common",
  kind: index % 3 ? "troop" : "spell",
  families: index % 5 === 0 ? ["cycle"] : [],
  forms: [{ key: "base", label: "Base", asset: `/card-${index + 1}.png` }],
}));

const roots: string[] = [];
const apps: Express[] = [];

afterEach(() => {
  for (const app of apps.splice(0)) (app.locals.arenaService as ArenaService).close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const createTestApp = (databasePath: string, now?: () => number) => {
  const app = createArenaApp({ catalog, catalogVersion: "social-test-v1", databasePath, now, initialDealMs: 0 });
  apps.push(app);
  return app;
};

const database = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "draft-royale-social-"));
  roots.push(root);
  return path.join(root, "arena.sqlite");
};

const browserToken = (byte: number) => Buffer.alloc(32, byte).toString("base64url");

const createProfile = async (app: Express, displayName: string, byte: number) => {
  const token = browserToken(byte);
  const response = await request(app).post("/api/social/profiles").send({ displayName, credentialToken: token }).expect(201);
  return response.body as SocialProfileResponse;
};

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const connect = async (app: Express, owner: SocialProfileResponse, recipient: SocialProfileResponse, suffix = "1") => {
  const created = await request(app).post("/api/social/friend-links").set(bearer(owner.credential.token)).send({ commandId: `link-${suffix}` }).expect(201);
  await request(app).post("/api/social/friend-links/accept").set(bearer(recipient.credential.token))
    .send({ token: created.body.friendLink.token, commandId: `accept-link-${suffix}` }).expect(200);
  return created.body.friendLink as { token: string; expiresAt: number };
};

const defaultSettings = {
  mode: "mega" as const,
  poolSize: 36,
  pickSeconds: 15,
  timerMode: "per_pick" as const,
  specialForms: true,
  battleMode: "Friendly 1v1",
};

describe("persistent social profiles and friends", () => {
  it("idempotently restores a browser-created credential and stores only its hash across restart", async () => {
    const databasePath = database();
    let app = createTestApp(databasePath);
    const token = browserToken(1);
    const first = await request(app).post("/api/social/profiles").send({ displayName: "Friend", credentialToken: token }).expect(201);
    const replay = await request(app).post("/api/social/profiles").send({ displayName: "Forged rename", credentialToken: token }).expect(200);
    expect(replay.body.credential).toEqual(first.body.credential);
    expect(replay.body.state.profile.displayName).toBe("Friend");

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const row = inspection.prepare("SELECT token_hash FROM social_profiles WHERE id = ?").get(first.body.credential.profileId) as { token_hash: string };
    expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(row.token_hash).not.toContain(token);
    inspection.close();

    (app.locals.arenaService as ArenaService).close();
    apps.splice(apps.indexOf(app), 1);
    app = createTestApp(databasePath);
    const restored = await request(app).get("/api/social/state").set(bearer(token)).expect(200);
    expect(restored.body.state.profile).toMatchObject({ id: first.body.credential.profileId, displayName: "Friend" });
    await request(app).get("/api/social/state").set(bearer(browserToken(9))).expect(401, { error: "Valid profile credentials are required", code: "UNAUTHORIZED" });
  });

  it("uses a friend link once, adds both friend lists, and prevents a third profile from removing their friendship", async () => {
    let timestamp = 5_000;
    const app = createTestApp(database(), () => timestamp);
    const host = await createProfile(app, "Host", 2);
    const guest = await createProfile(app, "Guest", 3);
    const outsider = await createProfile(app, "Outsider", 4);
    const link = await connect(app, host, guest);

    const hostState = await request(app).get("/api/social/state").set(bearer(host.credential.token)).expect(200);
    const guestState = await request(app).get("/api/social/state").set(bearer(guest.credential.token)).expect(200);
    expect(hostState.body.state.friends).toEqual([expect.objectContaining({ id: guest.credential.profileId, displayName: "Guest" })]);
    expect(guestState.body.state.friends).toEqual([expect.objectContaining({ id: host.credential.profileId, displayName: "Host" })]);

    await request(app).post("/api/social/friend-links/accept").set(bearer(outsider.credential.token))
      .send({ token: link.token, commandId: "steal-link" }).expect(409, { error: "This friend link was already used", code: "FRIEND_LINK_USED" });
    await request(app).post(`/api/social/friends/${guest.credential.profileId}/remove`).set(bearer(outsider.credential.token))
      .send({ commandId: "remove-others" }).expect(409, { error: "These profiles are not friends", code: "NOT_FRIENDS" });
    const stillFriends = await request(app).get("/api/social/state").set(bearer(host.credential.token)).expect(200);
    expect(stillFriends.body.state.friends).toHaveLength(1);

    await request(app).post(`/api/social/friends/${guest.credential.profileId}/remove`).set(bearer(host.credential.token))
      .send({ commandId: "remove-guest" }).expect(200);
    expect((await request(app).get("/api/social/state").set(bearer(guest.credential.token))).body.state.friends).toEqual([]);
    await request(app).post("/api/social/friend-links/accept").set(bearer(guest.credential.token))
      .send({ token: link.token, commandId: "reuse-consumed-link" })
      .expect(409, { error: "This friend link was already used", code: "FRIEND_LINK_USED" });
    timestamp += SOCIAL_FRIEND_LINK_TTL_MS + 1;
    await request(app).post("/api/social/friend-links/accept").set(bearer(guest.credential.token))
      .send({ token: link.token, commandId: "reuse-consumed-link-after-expiry" })
      .expect(409, { error: "This friend link was already used", code: "FRIEND_LINK_USED" });
    expect((await request(app).get("/api/social/state").set(bearer(host.credential.token))).body.state.friends).toEqual([]);
  });
});

describe("battle invitations", () => {
  it("creates the room only on acceptance, makes retries stable, and recovers only the caller's seat credential", async () => {
    const databasePath = database();
    const app = createTestApp(databasePath);
    const host = await createProfile(app, "Host", 5);
    const guest = await createProfile(app, "Guest", 6);
    const outsider = await createProfile(app, "Outsider", 7);
    await connect(app, host, guest, "battle");

    const created = await request(app).post("/api/social/invites").set(bearer(host.credential.token)).send({
      friendId: guest.credential.profileId,
      settings: defaultSettings,
      collection: null,
      commandId: "invite-1",
      name: "Forged Host",
    }).expect(201);
    const inviteId = created.body.invite.id as string;
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    expect((inspection.prepare("SELECT count(*) AS count FROM arena_rooms").get() as { count: number }).count).toBe(0);
    inspection.close();

    const createReplay = await request(app).post("/api/social/invites").set(bearer(host.credential.token)).send({
      friendId: guest.credential.profileId, settings: defaultSettings, collection: null, commandId: "invite-1",
    }).expect(201);
    expect(createReplay.body.invite.id).toBe(inviteId);
    await request(app).post("/api/social/invites").set(bearer(host.credential.token)).send({
      friendId: guest.credential.profileId, settings: { ...defaultSettings, pickSeconds: 30 }, collection: null, commandId: "invite-1",
    }).expect(409, { error: "commandId was already used for a different action", code: "COMMAND_CONFLICT" });

    await request(app).get(`/api/social/invites/${inviteId}/session`).set(bearer(outsider.credential.token))
      .expect(403, { error: "This invitation belongs to another profile", code: "INVITE_FORBIDDEN" });
    const accepted = await request(app).post(`/api/social/invites/${inviteId}/accept`).set(bearer(guest.credential.token))
      .send({ collection: null, commandId: "accept-battle" }).expect(200);
    expect(accepted.body.session).toMatchObject({ credential: { seat: "b" }, room: { phase: "waiting" } });
    expect(accepted.body.session.room.participants.map((participant: { name: string }) => participant.name)).toEqual(["Host", "Guest"]);
    const hostRoomToken = deriveSocialRoomToken(host.credential.token, inviteId, "a");
    expect(JSON.stringify(accepted.body)).not.toContain(hostRoomToken);
    const credentialInspection = new DatabaseSync(databasePath, { readOnly: true });
    const hashes = (credentialInspection.prepare("SELECT token_hash FROM arena_credentials WHERE room_id = ? ORDER BY seat").all(accepted.body.session.credential.roomId) as Array<{ token_hash: string }>).map((row) => row.token_hash);
    expect(hashes).toEqual([
      createHash("sha256").update(hostRoomToken).digest("hex"),
      createHash("sha256").update(accepted.body.session.credential.token).digest("hex"),
    ]);
    expect(JSON.stringify(hashes)).not.toContain(hostRoomToken);
    expect(JSON.stringify(hashes)).not.toContain(accepted.body.session.credential.token);
    const roomState = JSON.parse((credentialInspection.prepare("SELECT state_json FROM arena_rooms WHERE id = ?").get(accepted.body.session.credential.roomId) as { state_json: string }).state_json) as { megaPairKey?: string };
    const canonicalProfileIds = [host.credential.profileId, guest.credential.profileId].sort();
    expect(roomState.megaPairKey).toBe(createHash("sha256").update(JSON.stringify(canonicalProfileIds)).digest("hex"));
    credentialInspection.close();

    const acceptedReplay = await request(app).post(`/api/social/invites/${inviteId}/accept`).set(bearer(guest.credential.token))
      .send({ collection: null, commandId: "accept-battle" }).expect(200);
    expect(acceptedReplay.body.session.credential).toEqual(accepted.body.session.credential);
    await request(app).post(`/api/social/invites/${inviteId}/accept`).set(bearer(guest.credential.token))
      .send({ collection: { cards: ["card-1"], forms: null }, commandId: "accept-battle" })
      .expect(409, { error: "commandId was already used for a different action", code: "COMMAND_CONFLICT" });

    const hostSession = await request(app).get(`/api/social/invites/${inviteId}/session`).set(bearer(host.credential.token)).expect(200);
    const guestSession = await request(app).get(`/api/social/invites/${inviteId}/session`).set(bearer(guest.credential.token)).expect(200);
    expect(hostSession.body.session.credential).toMatchObject({ roomId: accepted.body.session.credential.roomId, seat: "a", token: hostRoomToken });
    expect(guestSession.body.session.credential).toEqual(accepted.body.session.credential);
    expect(hostSession.body.session.credential.token).not.toBe(guestSession.body.session.credential.token);
    expect((await request(app).get("/api/social/state").set(bearer(host.credential.token))).body.state.outgoingInvites[0]).toMatchObject({ id: inviteId, status: "accepted" });
  });

  it("enforces recipient decline and sender cancel transitions", async () => {
    const app = createTestApp(database());
    const host = await createProfile(app, "Host", 8);
    const guest = await createProfile(app, "Guest", 9);
    await connect(app, host, guest, "transitions");
    const first = await request(app).post("/api/social/invites").set(bearer(host.credential.token))
      .send({ friendId: guest.credential.profileId, settings: defaultSettings, commandId: "transition-1" }).expect(201);
    await request(app).post(`/api/social/invites/${first.body.invite.id}/decline`).set(bearer(host.credential.token))
      .send({ commandId: "wrong-decline" }).expect(403);
    const declined = await request(app).post(`/api/social/invites/${first.body.invite.id}/decline`).set(bearer(guest.credential.token))
      .send({ commandId: "decline" }).expect(200);
    expect(declined.body.invite.status).toBe("declined");

    const second = await request(app).post("/api/social/invites").set(bearer(host.credential.token))
      .send({ friendId: guest.credential.profileId, settings: defaultSettings, commandId: "transition-2" }).expect(201);
    await request(app).post(`/api/social/invites/${second.body.invite.id}/cancel`).set(bearer(guest.credential.token))
      .send({ commandId: "wrong-cancel" }).expect(403);
    const canceled = await request(app).post(`/api/social/invites/${second.body.invite.id}/cancel`).set(bearer(host.credential.token))
      .send({ commandId: "cancel" }).expect(200);
    expect(canceled.body.invite.status).toBe("canceled");
  });

  it("expires connection links and pending battle invitations using server time", async () => {
    let timestamp = 10_000;
    const app = createTestApp(database(), () => timestamp);
    const host = await createProfile(app, "Host", 10);
    const guest = await createProfile(app, "Guest", 11);
    const linkResponse = await request(app).post("/api/social/friend-links").set(bearer(host.credential.token)).send({ commandId: "expiring-link" }).expect(201);
    timestamp += SOCIAL_FRIEND_LINK_TTL_MS + 1;
    await request(app).post("/api/social/friend-links/accept").set(bearer(guest.credential.token))
      .send({ token: linkResponse.body.friendLink.token, commandId: "late-link" })
      .expect(410, { error: "This friend link expired", code: "FRIEND_LINK_EXPIRED" });

    timestamp += 1;
    await connect(app, host, guest, "fresh-link");
    const invitation = await request(app).post("/api/social/invites").set(bearer(host.credential.token))
      .send({ friendId: guest.credential.profileId, settings: defaultSettings, commandId: "expiring-invite" }).expect(201);
    timestamp += SOCIAL_INVITE_TTL_MS + 1;
    const state = await request(app).get("/api/social/state").set(bearer(guest.credential.token)).expect(200);
    expect(state.body.state.incomingInvites[0]).toMatchObject({ id: invitation.body.invite.id, status: "expired" });
    await request(app).post(`/api/social/invites/${invitation.body.invite.id}/accept`).set(bearer(guest.credential.token))
      .send({ commandId: "late-accept" }).expect(410, { error: "This battle invitation expired", code: "INVITE_EXPIRED" });
  });
});
