# Draft Royale

Draft Royale is an unofficial fan-made Clash Royale drafting companion. Draft in the browser, then use the completed deck link for a friendly battle. This material is unofficial and is not endorsed by Supercell.

This is a sanitized, source-only distribution. It contains original application code, generalized fixtures, the reviewed September 20, 2026 Arena catalog, and neutral placeholder artwork. It intentionally excludes private runtime data, personal fixtures, deployment state, private project history, game artwork, game UI artwork, and game fonts. The separate Chaos Infinite Elixir allowlist remains a dated September 5, 2026 snapshot.

## Run locally

Requires Node 24+ and pnpm 10+.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @draft-royale/server start
```

Open <http://localhost:4141>. `HOST` defaults to `127.0.0.1`, `PORT` defaults to `4141`, and `ARENA_DATABASE_PATH` can select a different private SQLite location. The default database path is ignored by Git.

For development:

```sh
pnpm dev
```

## Optional Clash Royale API access

Collection import and battle-log polling use the Clash Royale API from the server only. Store a user-created token only in ignored `data/private/tracker.env` as `CLASH_ROYALE_API_TOKEN=...`. `CLASH_ROYALE_API_BASE_URL` is optional and defaults to the documented RoyaleAPI proxy. A public player profile does not prove tag ownership.

New local accounts require a 12–128 character password distinct from the display name. To migrate a legacy account in an existing private database, run this in an interactive terminal:

```sh
ARENA_DATABASE_PATH=/absolute/path/to/arena.sqlite pnpm migrate:legacy-account -- player-name
```

The migration changes that account's password salt, hash, and version and rotates its linked social login credential, permanently revoking any bearer issued under the legacy password. It preserves profile IDs, friends, decks, rooms, and history.

## Validate

```sh
pnpm lint
pnpm typecheck
pnpm test
```

After starting the built server, `pnpm qa:arena` runs the isolated Playwright/Chromium browser harness against `http://localhost:4141` by default. Set `ARENA_QA_URL` and `ARENA_QA_OUTPUT_DIR` to override the target and evidence directory.

## Boundaries

- The catalog uses one original neutral placeholder for every card form. No Clash Royale card art or Supercell font is included.
- The application can draft cards and create deck links. It cannot unlock cards, configure the game client, prove public-tag ownership, or guarantee the chosen battle mode and special slots inside Clash Royale.
- `LICENSE` covers original code and documentation only. Read `NOTICE` for the fan-content and trademark boundary.
- Use a persistent private SQLite volume and backups for any hosted instance. Do not serve the repository root.
