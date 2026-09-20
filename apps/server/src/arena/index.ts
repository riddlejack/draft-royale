import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { createArenaRouter } from "./router.js";
import { ArenaError, createArenaService, type ArenaServiceOptions } from "./service.js";
import { createSocialRouter, createSocialService, SocialError } from "../social/index.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "../config.js";
import { createDeckService } from "../decks/service.js";
import { createDeckRouter } from "../decks/router.js";
import { createAccountService } from "../accounts/service.js";
import { createAccountRouter } from "../accounts/router.js";
import type { DeckDefinition, DeckCollection } from "@draft-royale/shared";
import { createMirrorRoomService, buildMirrorRemixCandidates } from "../mirror/service.js";
import { createMirrorRoomRouter } from "../mirror/router.js";
import { createTrackerService } from "../tracker/service.js";
import { createTrackerRouter } from "../tracker/router.js";

export * from "./service.js";
export * from "./router.js";

export const createArenaApp = (options: ArenaServiceOptions): Express => {
  const app = express();
  const service = createArenaService(options);
  const socialService = createSocialService({ arena: service, databasePath: options.databasePath, now: options.now });
  const deckService = createDeckService({ catalog: options.catalog, databasePath: options.databasePath ?? path.join(repoRoot, "data/private/arena.sqlite"), now: options.now });
  const accountService = createAccountService({ social: socialService, databasePath: options.databasePath ?? path.join(repoRoot, "data/private/arena.sqlite") });
  const deckSeeds = () => ({ version: 1, generatedAt: new Date().toISOString(), collections: ["video-2v2-decks.json", "classic-decks.json", "official-classic-decks.json"].flatMap((filename) => {
    const file = path.join(repoRoot, "data/catalog", filename);
    if (!existsSync(file)) return [];
    const data = JSON.parse(readFileSync(file, "utf8")) as { collections?: DeckCollection[] };
    return data.collections ?? [];
  }) });
  const allLibraryDecks = (): DeckDefinition[] => [...deckSeeds().collections.flatMap((collection) => collection.decks ?? []), ...deckService.list()];
  const librarySeeds = () => { const seeds = deckSeeds(); return { ...seeds, collections: [...seeds.collections, { id: "mirror-remixes", title: "Mirror remixes", mode: "mirror", description: "Every deck contains Mirror. Generated from library recipes; these are custom remixes, not Supercell’s official event pool.", decks: buildMirrorRemixCandidates(allLibraryDecks(), options.catalog).map((candidate) => candidate.deck) }] }; };
  const mirrorRoomService = createMirrorRoomService({ catalog: options.catalog, databasePath: options.databasePath ?? path.join(repoRoot, "data/private/arena.sqlite"), getDecks: allLibraryDecks });
  const trackerService = createTrackerService({ databasePath: options.databasePath ?? path.join(repoRoot, "data/private/arena.sqlite"), getPlayers: () => accountService.list(), apiToken: process.env.CLASH_ROYALE_API_TOKEN, apiBaseUrl: process.env.CLASH_ROYALE_API_BASE_URL });
  const closeArena = service.close.bind(service);
  service.close = () => {
    try {
      trackerService.close();
      mirrorRoomService.close();
      deckService.close();
      accountService.close();
      socialService.close();
    } finally {
      closeArena();
    }
  };
  app.use(express.json({ limit: "64kb" }));
  app.use(createSocialRouter(socialService));
  app.use(createDeckRouter(deckService, socialService, librarySeeds));
  app.use(createAccountRouter(accountService, socialService));
  app.use(createMirrorRoomRouter(mirrorRoomService));
  app.use(createTrackerRouter(trackerService, socialService));
  app.use(createArenaRouter(service));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof SocialError) {
      response.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    if (error instanceof ArenaError) {
      response.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      return;
    }
    const parsed = error as { status?: unknown; type?: unknown };
    if (parsed.status === 413 || parsed.type === "entity.too.large") {
      response.status(413).json({ error: "Request body is too large", code: "BODY_TOO_LARGE" });
      return;
    }
    if (parsed.status === 400 || parsed.type === "entity.parse.failed") {
      response.status(400).json({ error: "A valid JSON body is required", code: "INVALID_BODY" });
      return;
    }
    response.status(500).json({ error: "Arena request failed", code: "INTERNAL_ERROR" });
  });
  app.locals.arenaService = service;
  app.locals.socialService = socialService;
  app.locals.deckService = deckService;
  app.locals.accountService = accountService;
  app.locals.mirrorRoomService = mirrorRoomService;
  app.locals.trackerService = trackerService;
  return app;
};
