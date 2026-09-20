# Synchronized deck room API

All responses use `Cache-Control: no-store`. Room credentials are opaque bearer tokens. Store them per room and never put them in URLs.

## Create

`POST /api/mirror/rooms`

```json
{ "name": "Host", "playlist": "mirror" }
```

`playlist` is `mirror`, `classics`, or `community`; it defaults to `mirror`. An optional legal eight-card `deck` starts the room with a custom selection. A custom deck in the Mirror playlist must contain Mirror.

Response: `{ "credential": { "roomId", "seat": "a", "token" }, "room": MirrorRoomView }`.

## Join

`POST /api/mirror/join`

```json
{ "code": "ABC123", "name": "Friend" }
```

Response: `{ "credential": { "roomId", "seat": "b", "token" }, "room": MirrorRoomView }`.

## Poll

`GET /api/mirror/rooms/:id` with `Authorization: Bearer <token>`.

Response: `{ "room": MirrorRoomView }`. Both seats receive the same `deck`; `viewer` is seat-specific. Poll after a command or on a short interval to synchronize clients.

## Host commands

`POST /api/mirror/rooms/:id/command` with `Authorization: Bearer <token>`.

Every command includes the current `expectedRevision` and a unique `commandId`. Retrying the exact command is idempotent. Reusing a command ID with another payload or mutating a stale revision returns `409`.

```json
{ "action": "next", "expectedRevision": 4, "commandId": "uuid" }
```

Actions:

- `next`, `previous`, or `shuffle`
- `edit` plus a legal eight-card `deck`
- `playlist` plus `playlist: "mirror" | "classics" | "community"`

Only seat `a` can mutate the room. Response: `{ "room": MirrorRoomView }`.

`next` and `shuffle` do not repeat a playlist candidate until that playlist is exhausted. `previous` and forward `next` traverse durable room history, including edits and source provenance. Generated Mirror remixes are explicitly labeled as community-generated and not Supercell's official Mirror deck pool.
