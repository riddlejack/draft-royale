# Game tracker setup

The tracker stores only observations it has actually received. Clash Royale's battle-log endpoint is a recent rolling window, so this is not guaranteed to reconstruct games from before the tracker started or long periods while the server was offline.

Set `CLASH_ROYALE_API_TOKEN` in the server process environment. The token is used only by the backend and is never returned by a tracker route or requested by the browser. By default the server calls `https://proxy.royaleapi.dev/v1`; `CLASH_ROYALE_API_BASE_URL` can override that base for a compatible service.

For a source-checkout installation, place `CLASH_ROYALE_API_TOKEN=your-key` in `data/private/tracker.env` (ignored by Git) and restrict that file to your user with `chmod 600 data/private/tracker.env`. `DRAFT_ROYALE_TRACKER_ENV_PATH` can point the server at a separate persistent secret file. The packaged host service uses that override with `/path/to/DraftRoyale/config/tracker.env`, so a release update never replaces the key. Restart that service with `sudo launchctl kickstart -k system/com.example.draftroyale.server`. Keep the key out of chat and source control.

Observed games remain in SQLite across restarts; aggregate records use all stored, non-undone observations. The Recent Games list displays the latest 50. Back up the SQLite database when moving hosting, including accounts, decks, rooms, and game history together.

For the RoyaleAPI proxy, create the key following <https://docs.royaleapi.com/proxy.html> and whitelist `45.79.218.79` as the documented proxy address. Do not commit the token.

Without a token, authenticated users get a truthful `missing_token` status, an empty automatic history, and a working manual tally. The backend polls at a bounded interval, de-duplicates the same battle across player perspectives, backs off after errors or rate limits, times out stalled requests, and cancels active requests when it closes.
