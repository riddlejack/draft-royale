# 👑 Draft Royale

**Draft Clash Royale decks against your friends, with Evos, Heroes, and Champions.**

Provides much-needed improvements to friendly battles. In-game drafts pull from a fixed card pool, exclude Champions and Evolutions, and leave you with no say over the rules. Draft Royale moves the draft to the browser: two players draft live from the full card pool, Evos/Heroes included, then each opens the finished deck in Clash Royale with one tap and plays an ordinary friendly battle.

**[Play it at draft-royale.com →](https://draft-royale.com)**

## What you can do

- **Mega, Classic and Triple Draft.**
- **Evos, Heroes, and Champions.** Pick a card's form as you draft it, and the deck fills the game's special slots correctly.
- **Your rules.** Filter the pool by elixir cost, rarity, card type, or family, or include and exclude cards by hand. Set a timer per pick or for the whole draft. Add the Mirror card, or draft for a Chaos mode with its own pool.
- **Your cards.** Enter your player tag & the drafts will only include cards both players have unlocked.
- **Friends.** Add a friend with a one-time link, challenge them, and rematch from the same room. Or skip accounts and send anyone a room code.
- **Decks.** Save and edit decks, share them with friends, and see each card's record while you build. Same-deck battles hand both players the identical deck in the same order.
- **Match records.** Game analytics. The server keeps polling the public battle log for every tracked tag, so history builds up: head-to-head rivalries, the cards and decks you lose to, tilt after a loss, time of day, trophy timeline. Every figure shows its sample size.

Draft Royale never touches the game. It builds a deck and hands Clash Royale a deck link; you pick the battle mode in the game yourself.

## Run your own

Requires Node 24+ and pnpm 10+.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @draft-royale/server start
```

Open <http://localhost:4141>. Use `pnpm dev` while developing. Everything is one Express server, a React front end, and a SQLite file at `data/private/arena.sqlite` (ignored by Git; move it with `ARENA_DATABASE_PATH`). `HOST` defaults to `127.0.0.1` and `PORT` to `4141`.

Drafting works with no configuration. Collection import and match records need a free [Clash Royale API](https://developer.clashroyale.com) token. Put settings in `data/private/tracker.env`:

| Setting | What it does |
| --- | --- |
| `CLASH_ROYALE_API_TOKEN` | Enables collection import and battle-log tracking. Used by the server only. |
| `CLASH_ROYALE_API_BASE_URL` | Optional. Defaults to the [RoyaleAPI proxy](https://docs.royaleapi.com/proxy.html), which gives the token a fixed IP to allowlist. |
| `GOOGLE_OAUTH_CLIENT_ID` | Optional. Shows Google sign-in. A public Web client ID; no client secret is used. |
| `DRAFT_ROYALE_CLUB_TAGS` | Optional. Comma-separated tags of one friend group, written without `#`. The first account on each tag is befriended with the others. |

Accounts are named after the Clash Royale profile they track, and friends belong to the account, never to the tag, so tracking someone's public tag shows you none of their friends. A public profile does not prove who owns a tag.

Check your changes with `pnpm lint`, `pnpm typecheck`, and `pnpm test`. With the built server running, `pnpm qa:arena` drives a full two-player draft in a headless browser.

## What's not in this repository

No Clash Royale card art, game UI art, or game fonts: every card shows a neutral placeholder, and the live site's artwork is not redistributed here. No player data, deployment configuration, or private project history either.

[MIT license](LICENSE) for the original code. This material is unofficial and is not endorsed by Supercell; see [NOTICE](NOTICE) and Supercell's [Fan Content Policy](https://supercell.com/en/fan-content-policy/).
