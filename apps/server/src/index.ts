import express, { type ErrorRequestHandler } from "express";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { ArenaCatalogResponse } from "@draft-royale/shared";
import { createArenaApp } from "./arena/index.js";
import { repoRoot, serverPort } from "./config.js";

const trackerEnvPath = process.env.DRAFT_ROYALE_TRACKER_ENV_PATH
  ? path.resolve(process.env.DRAFT_ROYALE_TRACKER_ENV_PATH)
  : path.join(repoRoot, "data/private/tracker.env");
if (existsSync(trackerEnvPath)) process.loadEnvFile(trackerEnvPath);

const catalog = JSON.parse(readFileSync(path.join(repoRoot, "data/catalog/arena-catalog.json"), "utf8")) as ArenaCatalogResponse;
for (const card of catalog.cards) for (const form of card.forms) {
  const webp = form.asset.replace(/\.png$/, ".webp");
  if (existsSync(path.join(repoRoot, "public", webp))) form.asset = webp;
}
const databasePath = process.env.ARENA_DATABASE_PATH ?? path.join(repoRoot, "data/private/arena.sqlite");
mkdirSync(path.dirname(databasePath), { recursive: true });
const arenaApp = createArenaApp({ catalog: catalog.cards, catalogVersion: catalog.version, catalogUpdatedAt: catalog.updatedAt, databasePath });
const app = express();
const trustLoopbackProxy = (address: string) => address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
// The packaged tunnel connects over loopback. Never trust forwarded client IPs from a non-local peer.
app.set("trust proxy", trustLoopbackProxy);
arenaApp.set("trust proxy", trustLoopbackProxy);
const webRoot = process.env.DRAFT_ROYALE_WEB_ROOT ?? path.join(repoRoot, "apps/web/dist");
app.disable("x-powered-by");
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  next();
});
app.use(arenaApp);
app.get("/health", (_request, response) => response.json({ status: "ok", catalogVersion: catalog.version }));
app.use("/api", (_request, response) => response.status(404).json({ error: "Unknown endpoint", code: "NOT_FOUND" }));
app.use("/assets/royale", express.static(path.join(repoRoot, "public/assets/royale"), { maxAge: "1d" }));
app.use(express.static(webRoot, { maxAge: "1h", setHeaders: (response, file) => { if (file.endsWith("index.html")) response.setHeader("Cache-Control", "no-cache"); } }));
app.get("/{*path}", (_request, response) => response.sendFile(path.join(webRoot, "index.html"), { headers: { "Cache-Control": "no-cache" } }));
const handleError: ErrorRequestHandler = (error: { status?: number }, _request, response, _next) => {
  const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
  response.status(status).json({ error: status === 413 ? "Request is too large" : status === 400 ? "Invalid request" : "Unable to process the request", code: "REQUEST_ERROR" });
};
app.use(handleError);
const server = app.listen(serverPort, process.env.HOST ?? "127.0.0.1", () => {
  console.log(`Draft Royale listening on http://localhost:${serverPort}`);
});
const shutdown = () => {
  arenaApp.locals.arenaService.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
