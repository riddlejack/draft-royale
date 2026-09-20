#!/usr/bin/env node
/* global process, console, fetch, URL, setTimeout, document, HTMLElement, getComputedStyle, innerWidth, innerHeight, localStorage, performance */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const baseUrl = (process.env.ARENA_QA_URL ?? "http://localhost:4141").replace(/\/+$/, "");
const scope = process.env.ARENA_QA_SCOPE ?? "full";
const transport = process.env.ARENA_QA_TRANSPORT ?? "sse";
const outputDir = path.resolve(process.env.ARENA_QA_OUTPUT_DIR ?? "output/arena-qa-2026-09-05");
const summaryPath = path.join(outputDir, "summary.json");
const browserPluginReason = "Browser plugin not available; using playwright-core with a dedicated headless Chromium process.";
const runStartedAt = new Date().toISOString();
const phoneProfiles = {
  iphone16: { viewport: { width: 393, height: 852 }, screen: { width: 393, height: 852 } },
  proMax16: { viewport: { width: 440, height: 956 }, screen: { width: 440, height: 956 } },
  legacy: { viewport: { width: 320, height: 568 }, screen: { width: 320, height: 568 } },
  reducedSafari: { viewport: { width: 393, height: 660 }, screen: { width: 393, height: 660 } },
};
const modeLabels = { mega: "Mega Draft", triple: "Triple Draft", classic: "Classic Draft" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const secretValues = new Set();

async function waitUntil(check, message, timeoutMs = 10_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(message);
}

const summary = {
  ok: false,
  runStartedAt,
  runFinishedAt: null,
  baseUrl,
  scope,
  transport,
  browser: { path: null, headless: true, isolation: "new temporary context per phone", fallbackReason: browserPluginReason },
  viewports: phoneProfiles,
  flows: {},
  screenshots: [],
  diagnostics: [],
  failure: null,
};

const log = (message) => console.log(`[arena-qa] ${message}`);

async function exists(file) {
  if (!file) return false;
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function installedHeadlessShells() {
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  let directories = [];
  try {
    directories = await fs.readdir(cache);
  } catch {
    return [];
  }
  return directories
    .filter((entry) => entry.startsWith("chromium_headless_shell-"))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .flatMap((entry) => [
      path.join(cache, entry, "chrome-headless-shell-mac-arm64/chrome-headless-shell"),
      path.join(cache, entry, "chrome-headless-shell-mac-x64/chrome-headless-shell"),
    ]);
}

async function resolveBrowserExecutable() {
  const explicit = process.env.ARENA_QA_CHROMIUM_EXECUTABLE ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const candidates = [
    explicit,
    ...(await installedHeadlessShells()),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error("No isolated Chromium executable found. Set ARENA_QA_CHROMIUM_EXECUTABLE to a headless Chromium or Chrome binary.");
}

async function writeSummary() {
  summary.runFinishedAt = new Date().toISOString();
  await fs.mkdir(outputDir, { recursive: true });
  let output = JSON.stringify(summary, null, 2);
  for (const secret of secretValues) output = output.replaceAll(secret, "[REDACTED]");
  await fs.writeFile(summaryPath, `${output}\n`);
}

async function api(pathname, { credential, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(credential ? { Authorization: `Bearer ${credential.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => ({}));
  return { status: response.status, headers: response.headers, body: responseBody };
}

async function requireHealthyServer() {
  const [health, catalog] = await Promise.all([api("/health"), api("/api/arena/catalog")]);
  assert(health.status === 200 && health.body.status === "ok", `Health check failed at ${baseUrl}/health (${health.status})`);
  assert(catalog.status === 200 && Array.isArray(catalog.body.cards) && catalog.body.cards.length >= 120, "Arena catalog is unavailable or incomplete");
  const assets = catalog.body.cards.flatMap((card) => card.forms?.map((form) => form.asset) ?? []);
  const webpAssets = assets.filter((asset) => typeof asset === "string" && asset.endsWith(".webp"));
  assert(assets.length > 0 && webpAssets.length === assets.length,
    `Catalog asset transport is stale: ${webpAssets.length}/${assets.length} card forms use WebP. Restart the production server after asset compression.`);
  return { catalogVersion: catalog.body.version, cards: catalog.body.cards.length, cardForms: assets.length, webpCardForms: webpAssets.length };
}

function issueCollector(page, label) {
  const state = {
    label,
    issues: [],
    streamRequests: [],
    streamResponses: [],
    roomStateResponses: [],
    assetResponses: [],
    expectedResponses: [],
    expectedConsoleHttpErrorUntil: 0,
    expectedNetworkConsoleErrors: [],
    intentionalNetworkFaults: 0,
    ignoreNetworkFailuresUntil: 0,
  };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === new URL(baseUrl).origin && url.pathname.endsWith("/events")) {
      state.streamRequests.push({ pathname: url.pathname, method: request.method(), at: Date.now() });
    }
  });
  page.on("console", (message) => {
    const expectedNetworkError = state.expectedNetworkConsoleErrors.findIndex((pattern) => message.text().includes(pattern));
    if (message.type() === "error" && expectedNetworkError >= 0) {
      state.expectedNetworkConsoleErrors.splice(expectedNetworkError, 1);
      state.intentionalNetworkFaults += 1;
      return;
    }
    if (message.type() === "error" && Date.now() <= state.ignoreNetworkFailuresUntil && /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_ABORTED/.test(message.text())) {
      state.intentionalNetworkFaults += 1;
      return;
    }
    if (message.type() === "error" && Date.now() <= state.expectedConsoleHttpErrorUntil && /Failed to load resource/.test(message.text())) {
      return;
    }
    if (message.type() === "error") state.issues.push(`${label} console error: ${message.text()}`);
  });
  page.on("pageerror", (error) => state.issues.push(`${label} page error: ${error.message}`));
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(baseUrl).origin) return;
    const failure = request.failure()?.errorText ?? "unknown failure";
    if (failure === "net::ERR_ABORTED") return;
    if (Date.now() <= state.ignoreNetworkFailuresUntil) {
      state.intentionalNetworkFaults += 1;
      return;
    }
    state.issues.push(`${label} request failed: ${request.method()} ${url.pathname} (${failure})`);
  });
  page.on("response", (response) => {
    const request = response.request();
    const url = new URL(response.url());
    if (url.origin !== new URL(baseUrl).origin) return;
    if (url.pathname.endsWith("/events")) {
      state.streamResponses.push({
        pathname: url.pathname,
        status: response.status(),
        contentType: response.headers()["content-type"] ?? "",
      });
    }
    if (request.method() === "GET" && /^\/api\/arena\/rooms\/[^/]+$/.test(url.pathname)) {
      void response.json().then((body) => {
        state.roomStateResponses.push({ pathname: url.pathname, status: response.status(), revision: body.revision, at: Date.now() });
      }).catch(() => undefined);
    }
    if (url.pathname.startsWith("/assets/")) {
      state.assetResponses.push({
        pathname: url.pathname,
        status: response.status(),
        contentType: response.headers()["content-type"] ?? "",
      });
    }
    if (response.status() < 400) return;
    const expected = state.expectedResponses.find((item) =>
      item.remaining > 0 && item.method === request.method() && item.pathname === url.pathname && item.status === response.status());
    if (expected) {
      expected.remaining -= 1;
      return;
    }
    state.issues.push(`${label} HTTP ${response.status()}: ${request.method()} ${url.pathname}`);
  });
  return state;
}

function expectPageResponse(phone, method, pathname, status) {
  phone.collector.expectedResponses.push({ method, pathname, status, remaining: 1 });
  if (status >= 400) phone.collector.expectedConsoleHttpErrorUntil = Date.now() + 2_000;
}

async function createPhone(browser, label, profile) {
  const context = await browser.newContext({
    ...profile,
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
    locale: "en-US",
    colorScheme: "dark",
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.setDefaultNavigationTimeout(15_000);
  const collector = issueCollector(page, label);
  return { label, context, page, collector, profile };
}

async function screenshot(phone, name) {
  const file = path.join(outputDir, `${name}.png`);
  await fs.mkdir(outputDir, { recursive: true });
  await phone.page.screenshot({ path: file, fullPage: false });
  summary.screenshots.push(path.relative(process.cwd(), file));
  return file;
}

async function waitForHome(phone) {
  await phone.page.getByRole("heading", { name: /DRAFT\s*ROYALE/i }).waitFor({ state: "visible" });
}

async function openFreshHome(phone) {
  await phone.page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForHome(phone);
}

async function assertNoMissingImages(phone, label) {
  await phone.page.waitForFunction(() => Array.from(document.images).filter((image) => image.currentSrc).every((image) => image.complete), null, { timeout: 8_000 }).catch(() => {});
  const broken = await phone.page.evaluate(() => Array.from(document.images)
    .filter((image) => image.currentSrc && (image.naturalWidth === 0 || image.src.endsWith("/_invalid.png")))
    .map((image) => image.currentSrc));
  assert(broken.length === 0, `${label} has missing card/UI assets: ${broken.join(", ")}`);
  const localFontLoaded = await phone.page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check("16px Supercell");
  });
  assert(localFontLoaded, `${label} did not load the local Supercell heading font`);
}

function rectanglesOverlap(left, right, tolerance = 1) {
  return left.left < right.right - tolerance && left.right > right.left + tolerance
    && left.top < right.bottom - tolerance && left.bottom > right.top + tolerance;
}

async function assertLayout(phone, label) {
  const result = await phone.page.evaluate(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
    };
    const banner = document.querySelector(".arena-turn-banner");
    const timer = document.querySelector(".arena-timer:not(.is-idle)");
    const cards = Array.from(document.querySelectorAll(".arena-board .arena-cell")).filter(visible);
    const finishHeading = document.querySelector(".finish-heading");
    const finishedDeck = document.querySelector(".finished-deck");
    return {
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      viewportWidth: document.documentElement.clientWidth,
      stageWidth: document.querySelector(".draft-stage")?.scrollWidth ?? null,
      banner: banner && visible(banner) ? rect(banner) : null,
      timer: timer && visible(timer) ? rect(timer) : null,
      cards: cards.map(rect),
      finishHeading: finishHeading && visible(finishHeading) ? rect(finishHeading) : null,
      finishedDeck: finishedDeck && visible(finishedDeck) ? rect(finishedDeck) : null,
      clipped: Array.from(document.querySelectorAll(".arena-turn-banner,.arena-timer,.arena-board,.arena-tray,.finished-deck"))
        .filter(visible)
        .map((element) => ({ className: element.className, ...rect(element) }))
        .filter((item) => item.left < -1 || item.right > innerWidth + 1),
    };
  });
  assert(result.scrollWidth <= result.viewportWidth + 1, `${label} has page overflow ${result.scrollWidth}px > ${result.viewportWidth}px`);
  assert(result.stageWidth === null || result.stageWidth <= result.viewportWidth + 1, `${label} draft stage overflows horizontally`);
  assert(result.clipped.length === 0, `${label} clips key UI horizontally: ${JSON.stringify(result.clipped)}`);
  if (result.banner) {
    assert(!result.cards.some((card) => rectanglesOverlap(result.banner, card)), `${label} turn heading overlaps a draft card`);
  }
  if (result.timer) {
    assert(!result.cards.some((card) => rectanglesOverlap(result.timer, card)), `${label} timer overlaps a draft card`);
    if (result.banner) assert(!rectanglesOverlap(result.banner, result.timer), `${label} turn heading overlaps the timer`);
  }
  if (result.finishHeading && result.finishedDeck) {
    assert(!rectanglesOverlap(result.finishHeading, result.finishedDeck), `${label} completion heading overlaps deck cards`);
  }
  await assertNoMissingImages(phone, label);
  return result;
}

async function assertAtProfile(phone, profileName, label, screenshotName) {
  const profile = phoneProfiles[profileName];
  assert(profile, `Unknown phone profile ${profileName}`);
  await phone.page.setViewportSize(profile.viewport);
  await sleep(120);
  const actual = await phone.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert(actual.width === profile.viewport.width && actual.height === profile.viewport.height,
    `${label} rendered at ${actual.width}x${actual.height}, expected ${profile.viewport.width}x${profile.viewport.height}`);
  const layout = await assertLayout(phone, label);
  if (screenshotName) await screenshot(phone, screenshotName);
  return { profile: profileName, ...profile.viewport, scrollWidth: layout.scrollWidth };
}

async function configureHome(phone, mode, { exerciseCollection = false } = {}) {
  await waitForHome(phone);
  await phone.page.locator(".name-field input").fill(phone.label);
  await phone.page.locator(".mode-card").filter({ hasText: modeLabels[mode] }).click();
  await phone.page.locator(".rules-summary").click();
  const dialog = phone.page.locator(".settings-modal");
  await dialog.getByText("Battle rules").waitFor();
  await dialog.getByLabel("Draft clock").selectOption(mode === "mega" ? "per_pick" : "whole_draft");
  await dialog.locator(".setting-row").filter({ hasText: "Time limit" }).locator("select").selectOption(mode === "mega" ? "15" : "60");
  if (mode === "mega") {
    await dialog.getByRole("combobox", { name: "Maximum Mega Draft cards" }).selectOption("36");
  }
  const specials = dialog.getByRole("checkbox", { name: /^Special cards/ });
  if (!(await specials.isChecked())) await specials.check();
  await dialog.getByRole("button", { name: "Use these rules" }).click();
  if (exerciseCollection) {
    await phone.page.getByRole("button", { name: /My cards/i }).click();
    const collection = phone.page.locator(".collection-modal");
    await collection.getByRole("button", { name: "Base cards only" }).click();
    const specialForm = collection.locator(".collection-forms button").first();
    await specialForm.waitFor();
    assert((await specialForm.getAttribute("aria-pressed")) === "false", "Base cards only did not disable a special form");
    await collection.getByRole("button", { name: "All unlocked" }).click();
    assert((await specialForm.getAttribute("aria-pressed")) === "true", "All unlocked did not restore special forms");
    await collection.getByRole("button", { name: "Save collection" }).click();
    await collection.waitFor({ state: "detached" });
  }
}

async function savedCredential(phone, roomId) {
  const credential = await phone.page.evaluate((wanted) => {
    const raw = localStorage.getItem("draft-royale:rooms");
    const values = raw ? JSON.parse(raw) : [];
    return values.find((item) => item.roomId === wanted) ?? null;
  }, roomId);
  assert(credential?.roomId === roomId && typeof credential.token === "string" && credential.token.length >= 32, `${phone.label} did not retain the room credential`);
  secretValues.add(credential.token);
  return credential;
}

async function createRoomThroughUi(host, mode, options = {}) {
  await configureHome(host, mode, options);
  await host.page.getByRole("button", { name: "Invite by link", exact: true }).click();
  await host.page.getByRole("heading", { name: "Battle room" }).waitFor();
  const code = (await host.page.locator(".invite-panel > strong").textContent())?.trim() ?? "";
  assert(code.length >= 6, `Host did not receive an invite code for ${mode}`);
  const roomId = new URL(host.page.url()).hash.match(/^#room=(.+)$/)?.[1];
  assert(roomId, `Host URL did not identify the ${mode} room`);
  return { roomId: decodeURIComponent(roomId), code };
}

async function joinRoomThroughUi(guest, code, { proveFailure = false } = {}) {
  await waitForHome(guest);
  await guest.page.locator(".name-field input").fill(guest.label);
  await guest.page.getByRole("button", { name: /Join with a code/i }).click();
  const dialog = guest.page.locator(".join-modal");
  await dialog.getByRole("heading", { name: "Join your friend" }).waitFor();
  if (proveFailure) {
    expectPageResponse(guest, "POST", "/api/arena/join", 404);
    await dialog.locator(".code-input").fill("ZZZZZZ");
    await dialog.getByRole("button", { name: "Enter battle room" }).click();
    const alert = guest.page.getByRole("alert");
    await alert.getByText(/Invite code not found/i).waitFor();
    await alert.getByRole("button", { name: "Dismiss error" }).click();
  }
  await dialog.locator(".code-input").fill(code);
  await dialog.getByRole("button", { name: "Enter battle room" }).click();
  await guest.page.getByRole("heading", { name: "Battle room" }).waitFor();
}

async function exerciseLobbySettingsAndCollection(host, guest, room) {
  await host.page.locator(".room-scene .rules-summary").click();
  const settings = host.page.locator(".settings-modal");
  await settings.getByRole("heading", { name: "Battle rules" }).waitFor();
  await settings.getByLabel("Intended friendly battle").selectOption({ label: "Triple Elixir" });
  await settings.getByRole("button", { name: "Use these rules" }).click();
  await settings.waitFor({ state: "detached" });

  await guest.page.getByRole("button", { name: "My cards" }).click();
  const collection = guest.page.locator(".collection-modal");
  await collection.getByRole("heading", { name: "My cards" }).waitFor();
  await collection.getByRole("button", { name: "Base cards only" }).click();
  await collection.getByRole("button", { name: "All unlocked" }).click();
  await collection.getByRole("button", { name: "Save collection" }).click();
  await collection.waitFor({ state: "detached" });

  const [hostView, guestView] = await Promise.all([currentView(room.hostCredential), currentView(room.guestCredential)]);
  assert(hostView.settings.battleMode === "Triple Elixir" && guestView.settings.battleMode === "Triple Elixir",
    "Lobby settings did not converge on Triple Elixir");
  const guestParticipant = guestView.participants.find((participant) => participant.seat === "b");
  assert(guestParticipant?.collectionSource === "unrestricted", "Guest collection update did not remain unrestricted");
  return { battleMode: hostView.settings.battleMode, guestCollectionSource: guestParticipant.collectionSource };
}

async function waitForStream(phone, roomId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = phone.collector.streamResponses.find((item) => item.pathname === `/api/arena/rooms/${roomId}/events` && item.status === 200);
    if (match) {
      assert(match.contentType.includes("text/event-stream"), `${phone.label} events response is not SSE (${match.contentType})`);
      return match;
    }
    await sleep(100);
  }
  const observed = phone.collector.streamResponses.filter((item) => item.pathname.includes(roomId));
  throw new Error(`${phone.label} did not establish an authenticated SSE stream for ${roomId}; observed ${JSON.stringify(observed)}`);
}

function createAssetLoadGate(phone) {
  const origin = new URL(baseUrl).origin;
  let resolveSeen;
  let resolveRelease;
  let interceptedPath = null;
  let claimed = false;
  const seen = new Promise((resolve) => { resolveSeen = resolve; });
  const released = new Promise((resolve) => { resolveRelease = resolve; });
  const predicate = (url) => url.origin === origin && url.pathname === "/assets/royale/ui/arena-background.webp";
  const handler = async (route, request) => {
    if (claimed || request.method() !== "GET") return route.continue();
    claimed = true;
    interceptedPath = new URL(request.url()).pathname;
    resolveSeen();
    await released;
    await route.continue();
  };
  return {
    install: () => phone.context.route(predicate, handler),
    waitUntilSeen: () => Promise.race([
      seen,
      sleep(5_000).then(() => { throw new Error("LoadingArena did not request its arena artwork through the delayed transport gate"); }),
    ]),
    release: () => resolveRelease(),
    remove: () => phone.context.unroute(predicate, handler),
    path: () => interceptedPath,
  };
}

async function assertLoadingHandshake(host, guest, room, gate) {
  await Promise.all([
    host.page.getByRole("heading", { name: /Getting your cards ready|Waiting for your rival/ }).waitFor(),
    guest.page.getByRole("heading", { name: /Getting your cards ready|Waiting for your rival/ }).waitFor(),
    gate.waitUntilSeen(),
  ]);
  await sleep(250);
  const [hostView, guestView] = await Promise.all([currentView(room.hostCredential), currentView(room.guestCredential)]);
  for (const [label, view] of [["host", hostView], ["guest", guestView]]) {
    assert(view.phase === "loading", `${label} left loading before both clients acknowledged assets`);
    assert(view.activeSeat === null && view.startedAt === null && view.interactiveAt === null && view.deadlineAt === null,
      `${label} received an active turn or timer while card transport was blocked`);
    assert(view.participants.some((participant) => !participant.loaded), `${label} says every participant loaded while one card response is blocked`);
  }
  for (const phone of [host, guest]) {
    assert(await phone.page.locator(".draft-stage").count() === 0, `${phone.label} rendered the draft while assets were blocked`);
    assert(await phone.page.locator(".arena-timer.is-running").count() === 0, `${phone.label} started its timer while assets were blocked`);
  }
  await screenshot(guest, "mega-loading-handshake-blocked");
  return {
    phaseWhileBlocked: hostView.phase,
    startedAtWhileBlocked: hostView.startedAt,
    interactiveAtWhileBlocked: hostView.interactiveAt,
    deadlineAtWhileBlocked: hostView.deadlineAt,
    blockedAssetPath: gate.path(),
  };
}

async function readyBoth(host, guest, room, { proveAssetHandshake = false } = {}) {
  await host.page.getByRole("button", { name: "I'm ready" }).click();
  await host.page.getByRole("button", { name: /Ready — waiting for rival/ }).waitFor();
  const gate = proveAssetHandshake ? createAssetLoadGate(guest) : null;
  if (gate) await gate.install();
  await guest.page.getByRole("button", { name: "I'm ready" }).click();
  const handshake = gate ? await assertLoadingHandshake(host, guest, room, gate) : null;
  gate?.release();
  await Promise.all([
    host.page.locator(".draft-stage").waitFor({ state: "visible" }),
    guest.page.locator(".draft-stage").waitFor({ state: "visible" }),
  ]);
  if (gate) await gate.remove();
  await sleep(400);
  const [hostView, guestView] = await Promise.all([currentView(room.hostCredential), currentView(room.guestCredential)]);
  assert(hostView.phase === "drafting" && guestView.phase === "drafting", "Room did not enter drafting after both clients loaded assets");
  assert(hostView.startedAt !== null && hostView.interactiveAt !== null && hostView.deadlineAt !== null,
    "Draft timer anchors were not created after loading acknowledgements");
  return handshake ? { ...handshake, draftingAfterRelease: true } : null;
}

async function setupTwoPhoneRoom(host, guest, mode, options = {}) {
  const created = await createRoomThroughUi(host, mode, options);
  await joinRoomThroughUi(guest, created.code, { proveFailure: options.proveFailure });
  const hostCredential = await savedCredential(host, created.roomId);
  const guestCredential = await savedCredential(guest, created.roomId);
  if (transport === "sse") {
    await Promise.all([waitForStream(host, created.roomId), waitForStream(guest, created.roomId)]);
  }
  const room = { ...created, hostCredential, guestCredential };
  const lobbyControls = options.exerciseLobbyControls ? await exerciseLobbySettingsAndCollection(host, guest, room) : null;
  const loadingHandshake = await readyBoth(host, guest, room, { proveAssetHandshake: options.proveAssetHandshake });
  return { ...room, lobbyControls, loadingHandshake };
}

async function waitForInteractiveBoard(phone, count, { requireEnabled = true } = {}) {
  await phone.page.locator(requireEnabled ? ".arena-cell:enabled" : ".arena-board .arena-cell").first().waitFor({ state: "visible", timeout: 12_000 });
  if (count !== undefined) {
    await phone.page.waitForFunction((expected) => document.querySelectorAll(".arena-board .arena-cell").length === expected, count, { timeout: 8_000 });
  }
}

function chooseFormButton(dialog) {
  return dialog.locator('button[aria-label$="as Evolution"],button[aria-label$="as Hero"],button[aria-label$="as Champion"]').first();
}

async function performUiPick(phone, { expectedStatus = 200 } = {}) {
  const page = phone.page;
  const endpoint = /\/api\/arena\/rooms\/[^/]+\/pick$/;
  const responsePromise = page.waitForResponse((response) => endpoint.test(new URL(response.url()).pathname) && response.request().method() === "POST");
  let usedChooser = false;
  let cardKey = null;
  let position = null;
  let requestedForm = null;
  let submittedAt = null;
  const openDialog = page.locator(".arena-form-dialog");
  if (await openDialog.isVisible().catch(() => false)) {
    usedChooser = true;
    let option = chooseFormButton(openDialog);
    if ((await option.count()) === 0) option = openDialog.locator('button[aria-label^="Pick "]').first();
    requestedForm = (await option.getAttribute("aria-label"))?.match(/ as (.+)$/)?.[1]?.toLowerCase() ?? null;
    submittedAt = Date.now();
    await option.click();
  } else {
    await waitForInteractiveBoard(phone);
    let cell = page.locator('.arena-cell:enabled[aria-label*="choose form"]').first();
    if ((await cell.count()) === 0) cell = page.locator(".arena-cell:enabled").first();
    cardKey = await cell.getAttribute("data-arena-card-key");
    position = Number(await cell.getAttribute("data-arena-position"));
    submittedAt = Date.now();
    await cell.click();
    if (await openDialog.isVisible().catch(() => false)) {
      usedChooser = true;
      let option = chooseFormButton(openDialog);
      if ((await option.count()) === 0) option = openDialog.locator('button[aria-label^="Pick "]').first();
      requestedForm = (await option.getAttribute("aria-label"))?.match(/ as (.+)$/)?.[1]?.toLowerCase() ?? null;
      submittedAt = Date.now();
      await option.click();
    }
  }
  const response = await responsePromise;
  assert(response.status() === expectedStatus, `${phone.label} pick returned ${response.status()}, expected ${expectedStatus}`);
  const body = await response.json().catch(() => ({}));
  assert(submittedAt !== null, `${phone.label} did not submit a pick`);
  return { body, cardKey, position, requestedForm, usedChooser, submittedAt };
}

async function currentView(credential) {
  const response = await api(`/api/arena/rooms/${encodeURIComponent(credential.roomId)}`, { credential });
  assert(response.status === 200, `Authenticated room view failed (${response.status})`);
  return response.body;
}

async function assertPrivacy(roomId, hostCredential, guestCredential, mode) {
  const [none, invalid, host, guest] = await Promise.all([
    api(`/api/arena/rooms/${roomId}`),
    api(`/api/arena/rooms/${roomId}`, { credential: { roomId, seat: "a", token: "not-a-valid-token" } }),
    currentView(hostCredential),
    currentView(guestCredential),
  ]);
  assert(none.status === 401, `${mode} room read without auth returned ${none.status}, expected 401`);
  assert(invalid.status === 401, `${mode} room read with invalid auth returned ${invalid.status}, expected 401`);
  assert(host.viewer === "a" && guest.viewer === "b", `${mode} credentials did not produce seat-specific views`);
  if (mode !== "mega" && host.phase === "drafting" && guest.phase === "drafting") {
    assert(host.events.every((event) => event.seat === "a") && guest.events.every((event) => event.seat === "b"), `${mode} leaked the other private event lane`);
    for (const view of [host, guest]) {
      const ownOffer = view.board.filter((cell) => cell.offeredTo === view.viewer);
      const opponentOffer = view.board.filter((cell) => cell.offeredTo !== undefined && cell.offeredTo !== view.viewer);
      assert(ownOffer.length === (mode === "classic" ? 2 : 3), `${mode} ${view.viewer} own offer has ${ownOffer.length} cards`);
      assert(ownOffer.every((cell) => cell.legalForms.length > 0), `${mode} ${view.viewer} own offer contains a non-interactive card`);
      if (mode === "triple") {
        assert(opponentOffer.length === 3, `triple ${view.viewer} cannot see all three opponent options`);
        assert(opponentOffer.every((cell) => cell.legalForms.length === 0), `triple ${view.viewer} can interact with the opponent offer`);
      } else {
        assert(opponentOffer.length === 0, `classic ${view.viewer} exposed an unrelated opponent offer`);
      }
    }
    const ownHostKeys = host.board.filter((cell) => cell.offeredTo === "a").map((cell) => cell.cardKey);
    const ownGuestKeys = guest.board.filter((cell) => cell.offeredTo === "b").map((cell) => cell.cardKey);
    const overlap = ownHostKeys.filter((key) => ownGuestKeys.includes(key));
    assert(overlap.length === 0, `${mode} private own offers overlap: ${overlap.join(", ")}`);
  }
  return { unauthorizedStatus: none.status, invalidStatus: invalid.status };
}

function deckIds(exportUrl) {
  const decoded = decodeURIComponent(exportUrl);
  const marker = decoded.indexOf("deck=");
  assert(marker >= 0, `Deck export has no deck payload: ${exportUrl}`);
  return decoded.slice(marker + 5).split("&")[0].split(";").filter(Boolean).map((value) => Number(value));
}

function assertExport(view, label) {
  assert(view.phase === "complete", `${label} did not reach complete phase`);
  assert(view.export?.entries?.length === 8, `${label} export does not contain eight entries`);
  const entryKeys = view.export.entries.map((entry) => entry.cardKey);
  assert(new Set(entryKeys).size === 8, `${label} export repeats a card identity`);
  const ids = deckIds(view.export.url);
  assert(ids.length === 8 && ids.every(Number.isInteger), `${label} deck link does not contain eight numeric IDs`);
  assert(new Set(ids).size === 8, `${label} deck link repeats a card ID`);
  return ids;
}

async function megaPositions(phone) {
  return phone.page.locator(".arena-board .arena-cell").evaluateAll((cells) => cells.map((cell) => ({
    position: Number(cell.getAttribute("data-arena-position")),
    cardKey: cell.getAttribute("data-arena-card-key"),
  })));
}

async function pinRoomPolling(phone, credential, staleView) {
  const pathname = `/api/arena/rooms/${encodeURIComponent(credential.roomId)}`;
  const predicate = (url) => url.origin === new URL(baseUrl).origin && url.pathname === pathname;
  const handler = async (route, request) => {
    if (request.method() !== "GET") return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(staleView) });
  };
  await phone.context.route(predicate, handler);
  return () => phone.context.unroute(predicate, handler);
}

async function waitForStreamCount(phone, roomId, minimum, timeoutMs = 10_000) {
  const pathname = `/api/arena/rooms/${roomId}/events`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (phone.collector.streamResponses.filter((item) => item.pathname === pathname && item.status === 200).length >= minimum) return;
    await sleep(100);
  }
  throw new Error(`${phone.label} did not restore its authenticated SSE stream after polling fallback`);
}

async function waitForPollingRevision(phone, roomId, revision, submittedAt) {
  const pathname = `/api/arena/rooms/${roomId}`;
  return waitUntil(
    () => phone.collector.roomStateResponses.find((item) =>
      item.pathname === pathname && item.status === 200 && item.at >= submittedAt && item.revision >= revision),
    `${phone.label} did not receive revision ${revision} through its one-second room-state poll`,
    3_500,
    50,
  );
}

async function forceSseFallbackToPolling(phone, roomId) {
  const origin = new URL(baseUrl).origin;
  const pathname = `/api/arena/rooms/${roomId}/events`;
  const initialStreams = phone.collector.streamResponses.filter((item) => item.pathname === pathname && item.status === 200).length;
  assert(initialStreams >= 1, `${phone.label} had no SSE stream to interrupt`);
  const predicate = (url) => url.origin === origin && url.pathname === pathname;
  const handler = (route) => route.abort("aborted");
  phone.collector.ignoreNetworkFailuresUntil = Date.now() + 5_000;
  await phone.context.setOffline(true);
  await phone.page.locator(".connection-banner").waitFor({ state: "visible", timeout: 4_000 });
  await phone.context.route(predicate, handler);
  await phone.context.setOffline(false);
  return {
    initialStreams,
    restore: async () => {
      await phone.context.unroute(predicate, handler);
      await phone.page.reload({ waitUntil: "domcontentloaded" });
      await phone.page.locator(".draft-stage").waitFor({ state: "visible" });
      await waitForStreamCount(phone, roomId, initialStreams + 1, 12_000);
    },
  };
}

async function observePollingCompletion(phone, submittedAt) {
  await phone.page.locator(".arena-flying-card").first().waitFor({ state: "visible", timeout: 1_500 });
  const observedAt = Date.now();
  const updateLagMs = observedAt - submittedAt;
  assert(updateLagMs <= 1_500, `${phone.label} observed final completion ${updateLagMs}ms after submission through polling`);
  await sleep(Math.max(0, 450 - (Date.now() - observedAt)));
  assert(await phone.page.locator(".draft-stage").isVisible(), `${phone.label} removed the polling-driven arena before the final pick flight completed`);
  await phone.page.getByRole("heading", { name: "Deck ready!" }).waitFor({ timeout: 1_800 });
  const presentationMs = Date.now() - observedAt;
  assert(presentationMs >= 500 && presentationMs < 2_000,
    `${phone.label} polling completion presentation lasted ${presentationMs}ms, expected a bounded live transition`);
  return { updateLagMs, presentationMs };
}

async function waitMegaConvergence(host, guest, pick, picker) {
  if (pick.body.phase === "complete") {
    if (transport === "polling") {
      const [hostPresentation, guestPresentation, hostPoll, guestPoll] = await Promise.all([
        observePollingCompletion(host, pick.submittedAt),
        observePollingCompletion(guest, pick.submittedAt),
        waitForPollingRevision(host, pick.body.id, pick.body.revision, pick.submittedAt),
        waitForPollingRevision(guest, pick.body.id, pick.body.revision, pick.submittedAt),
      ]);
      const opponent = picker === host ? guestPresentation : hostPresentation;
      assert(opponent.updateLagMs <= 1_500, `Polling opponent completion lagged ${opponent.updateLagMs}ms`);
      return {
        phase: "complete",
        presentationMs: Math.max(hostPresentation.presentationMs, guestPresentation.presentationMs),
        perPhone: { host: hostPresentation, guest: guestPresentation },
        polling: { hostRevision: hostPoll.revision, guestRevision: guestPoll.revision },
      };
    }
    const observedAt = Date.now();
    await Promise.all([host, guest].flatMap((phone) => [
      phone.page.locator(".draft-stage").waitFor({ state: "visible", timeout: 700 }),
      phone.page.locator(".arena-flying-card").first().waitFor({ state: "visible", timeout: 700 }),
    ]));
    await sleep(Math.max(0, 450 - (Date.now() - observedAt)));
    for (const phone of [host, guest]) {
      assert(await phone.page.locator(".draft-stage").isVisible(), `${phone.label} removed the live arena before the final pick flight completed`);
    }
    await Promise.all([
      host.page.getByRole("heading", { name: "Deck ready!" }).waitFor({ timeout: 1_800 }),
      guest.page.getByRole("heading", { name: "Deck ready!" }).waitFor({ timeout: 1_800 }),
    ]);
    const presentationMs = Date.now() - observedAt;
    assert(presentationMs >= 500 && presentationMs < 2_000,
      `Final-pick completion presentation lasted ${presentationMs}ms, expected a bounded live transition`);
    return { phase: "complete", presentationMs };
  }
  let polling = null;
  if (transport === "polling") {
    const [hostPoll, guestPoll] = await Promise.all([
      waitForPollingRevision(host, pick.body.id, pick.body.revision, pick.submittedAt),
      waitForPollingRevision(guest, pick.body.id, pick.body.revision, pick.submittedAt),
    ]);
    polling = { hostRevision: hostPoll.revision, guestRevision: guestPoll.revision };
  }
  const selector = `.arena-cell[data-arena-position="${pick.position}"][data-arena-card-key="${pick.cardKey}"].is-picked`;
  for (const phone of [host, guest]) {
    await phone.page.locator(selector).waitFor({ state: "visible", timeout: 5_000 })
      .catch(() => { throw new Error(`${phone.label} did not converge on accepted Mega pick ${pick.cardKey} at position ${pick.position}`); });
  }
  for (const phone of [host, guest]) {
    const selectedFace = phone.page.locator(`${selector} .arena-card-face.is-selected`);
    await selectedFace.waitFor();
    const filter = await selectedFace.locator(".arena-card-art").evaluate((image) => getComputedStyle(image).filter);
    assert(filter.includes("grayscale(1)"), `${phone.label} does not gray accepted Mega picks`);
  }
  return { phase: "drafting", presentationMs: null, polling };
}

async function reloadAndAssertResume(phone, credential, expectedRevision, expectedPicked) {
  const before = await savedCredential(phone, credential.roomId);
  const pathname = `/api/arena/rooms/${credential.roomId}/events`;
  const streamCount = phone.collector.streamResponses.filter((item) => item.pathname === pathname && item.status === 200).length;
  await phone.page.reload({ waitUntil: "domcontentloaded" });
  await phone.page.locator(".draft-stage").waitFor();
  await phone.page.waitForFunction((minimum) => document.querySelectorAll(".arena-cell.is-picked").length >= minimum, expectedPicked, { timeout: 5_000 });
  if (transport === "sse") await waitForStreamCount(phone, credential.roomId, streamCount + 1, 8_000);
  const after = await savedCredential(phone, credential.roomId);
  assert(before.token === after.token && after.token === credential.token, `${phone.label} did not resume with the same credential`);
  const view = await currentView(credential);
  assert(view.revision >= expectedRevision, `${phone.label} resumed stale revision ${view.revision} < ${expectedRevision}`);
}

async function reloadCompletedRoomImmediately(phone, credential) {
  const startedAt = Date.now();
  await phone.page.reload({ waitUntil: "domcontentloaded" });
  await phone.page.getByRole("heading", { name: "Deck ready!" }).waitFor({ timeout: 3_000 });
  const elapsedMs = Date.now() - startedAt;
  assert(await phone.page.locator(".draft-stage").count() === 0, `${phone.label} replayed the final-pick arena transition when resuming a completed room`);
  assert((await currentView(credential)).phase === "complete", `${phone.label} did not resume the completed server state`);
  return { elapsedMs, skippedLivePresentation: true };
}

async function exerciseFailedPickUi(phone, roomId) {
  const endpoint = `/api/arena/rooms/${roomId}/pick`;
  let intercepted = false;
  const handler = async (route, request) => {
    if (request.method() !== "POST" || intercepted) return route.continue();
    intercepted = true;
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "QA forced revision conflict", code: "REVISION_CONFLICT" }) });
  };
  expectPageResponse(phone, "POST", endpoint, 409);
  await phone.page.route((url) => url.origin === new URL(baseUrl).origin && url.pathname === endpoint, handler);
  await performUiPick(phone, { expectedStatus: 409 });
  await phone.page.getByRole("alert").getByText("QA forced revision conflict").waitFor();
  await phone.page.getByRole("alert").getByRole("button", { name: "Dismiss error" }).click();
  await phone.page.unroute((url) => url.origin === new URL(baseUrl).origin && url.pathname === endpoint, handler);
  assert(intercepted, "The forced failed-pick UI path was not exercised");
}

async function triggerPickWithoutWaiting(phone) {
  await waitForInteractiveBoard(phone);
  let cell = phone.page.locator('.arena-cell:enabled:not([aria-label*="choose form"])').first();
  if ((await cell.count()) === 0) cell = phone.page.locator(".arena-cell:enabled").first();
  await cell.click();
  const chooser = phone.page.locator(".arena-form-dialog");
  if (await chooser.isVisible().catch(() => false)) {
    const base = chooser.locator('button[aria-label$="as Base"]').first();
    await ((await base.count()) > 0 ? base : chooser.locator('button[aria-label^="Pick "]').first()).click();
  }
}

async function runCatalogRetryFault(browser) {
  log("faults: recover global and room catalog requests without navigation");
  const phone = await createPhone(browser, "QA Catalog Retry", phoneProfiles.iphone16);
  const origin = new URL(baseUrl).origin;
  let globalAttempts = 0;
  let roomAttempts = 0;
  let roomCatalogAuthorized = false;
  const globalPredicate = (url) => url.origin === origin && url.pathname === "/api/arena/catalog";
  const globalHandler = async (route) => {
    globalAttempts += 1;
    if (globalAttempts === 1) {
      expectPageResponse(phone, "GET", "/api/arena/catalog", 503);
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "QA forced global catalog outage", code: "QA_CATALOG_OUTAGE" }) });
      return;
    }
    await route.continue();
  };
  const roomPredicate = (url) => url.origin === origin && /^\/api\/arena\/rooms\/[^/]+\/catalog$/.test(url.pathname);
  const roomHandler = async (route, request) => {
    roomAttempts += 1;
    roomCatalogAuthorized ||= /^Bearer\s+\S+/.test(request.headers().authorization ?? "");
    if (roomAttempts === 1) {
      const pathname = new URL(request.url()).pathname;
      expectPageResponse(phone, "GET", pathname, 503);
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "QA forced room catalog outage", code: "QA_ROOM_CATALOG_OUTAGE" }) });
      return;
    }
    await route.continue();
  };
  try {
    await phone.context.route(globalPredicate, globalHandler);
    await phone.context.route(roomPredicate, roomHandler);
    await phone.page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForHome(phone);
    const timeOrigin = await phone.page.evaluate(() => performance.timeOrigin);
    await phone.page.getByRole("alert").getByText(/Card data couldn't load/i).waitFor();
    assert(await phone.page.getByRole("button", { name: /Challenge a friend/i }).isDisabled(), "Create-room action stayed enabled without the global catalog");
    await phone.page.getByRole("button", { name: /try again|retry/i }).first().click();
    await phone.page.getByRole("button", { name: /Challenge a friend/i }).waitFor({ state: "visible" });
    await waitUntil(() => phone.page.getByRole("button", { name: /Challenge a friend/i }).isEnabled(), "Global catalog retry did not re-enable room creation");
    assert(globalAttempts >= 2, `Global catalog was requested ${globalAttempts} time(s), expected a retry`);

    const created = await createRoomThroughUi(phone, "mega");
    await waitUntil(() => Promise.resolve(roomAttempts >= 1), "Room-specific catalog endpoint was not requested after opening a room");
    await phone.page.getByRole("alert").getByText(/Card data couldn't load/i).waitFor();
    await phone.page.getByRole("button", { name: /try again|retry/i }).first().click();
    await waitUntil(() => Promise.resolve(roomAttempts >= 2), "Room catalog retry was not issued");
    await phone.page.getByRole("alert").waitFor({ state: "hidden", timeout: 5_000 });
    assert(roomCatalogAuthorized, "Room catalog request omitted its bearer credential");
    assert(await phone.page.evaluate(() => performance.timeOrigin) === timeOrigin, "Catalog recovery reloaded the page");
    await phone.page.getByRole("button", { name: "My cards" }).click();
    await phone.page.locator(".collection-modal .collection-card").first().waitFor({ state: "visible" });
    await phone.page.getByRole("button", { name: "Close collection" }).click();
    const credential = await savedCredential(phone, created.roomId);
    const roomView = await currentView(credential);
    assert(roomView.id === created.roomId && roomView.phase === "waiting", "Catalog retry lost the active room");
    await screenshot(phone, "fault-catalog-retry-recovered");
    await phone.context.unroute(globalPredicate, globalHandler);
    await phone.context.unroute(roomPredicate, roomHandler);
    assertPhoneClean(phone);
    return { globalAttempts, roomAttempts, roomCatalogAuthorized, recoveredWithoutNavigation: true };
  } catch (error) {
    await screenshot(phone, "failure-fault-catalog-retry").catch(() => undefined);
    summary.diagnostics.push(...phone.collector.issues);
    throw error;
  } finally {
    await phone.context.close();
  }
}

async function runLateAcknowledgementFault(browser) {
  log("faults: ignore a committed pick response after leaving and opening a new room");
  const host = await createPhone(browser, "QA Late Ack Host", phoneProfiles.iphone16);
  const guest = await createPhone(browser, "QA Late Ack Guest", phoneProfiles.proMax16);
  let releaseResponse;
  let resolveCommitted;
  const responseRelease = new Promise((resolve) => { releaseResponse = resolve; });
  const committed = new Promise((resolve) => { resolveCommitted = resolve; });
  try {
    await Promise.all([openFreshHome(host), openFreshHome(guest)]);
    const oldRoom = await setupTwoPhoneRoom(host, guest, "mega");
    const openingView = await currentView(oldRoom.hostCredential);
    assert(openingView.phase === "drafting" && openingView.activeSeat, "Late-ack room did not assign a Mega starter");
    const actor = openingView.activeSeat === "a" ? host : guest;
    const actorCredential = openingView.activeSeat === "a" ? oldRoom.hostCredential : oldRoom.guestCredential;
    await waitForInteractiveBoard(actor, 36);
    const pathname = `/api/arena/rooms/${oldRoom.roomId}/pick`;
    const predicate = (url) => url.origin === new URL(baseUrl).origin && url.pathname === pathname;
    const handler = async (route, request) => {
      if (request.method() !== "POST") return route.continue();
      const upstream = await route.fetch();
      resolveCommitted();
      await responseRelease;
      await route.fulfill({ response: upstream });
    };
    await actor.context.route(predicate, handler);
    await triggerPickWithoutWaiting(actor);
    await Promise.race([committed, sleep(6_000).then(() => { throw new Error("Delayed pick was not committed upstream"); })]);
    await actor.page.getByRole("button", { name: "Leave draft" }).click();
    await waitForHome(actor);
    const newRoom = await createRoomThroughUi(actor, "mega");
    const newCredential = await savedCredential(actor, newRoom.roomId);
    releaseResponse();
    await sleep(750);
    assert(new URL(actor.page.url()).hash === `#room=${encodeURIComponent(newRoom.roomId)}`, "Late pick response replaced the new room URL");
    await actor.page.getByRole("heading", { name: "Battle room" }).waitFor();
    const [oldView, newView] = await Promise.all([currentView(actorCredential), currentView(newCredential)]);
    assert(oldView.events.length === 1, `Committed old-room pick produced ${oldView.events.length} events`);
    assert(newView.id === newRoom.roomId && newView.phase === "waiting" && newView.events.length === 0,
      "Late old-room response corrupted or replaced the new room");
    await actor.context.unroute(predicate, handler);
    await screenshot(actor, "fault-late-pick-ack-new-room-stable");
    assertPhoneClean(host);
    assertPhoneClean(guest);
    return { committedOldRoomEvents: oldView.events.length, newRoomEvents: newView.events.length, newRoomRemainedActive: true };
  } catch (error) {
    releaseResponse?.();
    await Promise.allSettled([screenshot(host, "failure-fault-late-ack-host"), screenshot(guest, "failure-fault-late-ack-guest")]);
    summary.diagnostics.push(...host.collector.issues, ...guest.collector.issues);
    throw error;
  } finally {
    await Promise.allSettled([host.context.close(), guest.context.close()]);
  }
}

async function runCommandRetryAndTimerFault(browser) {
  log("faults: retry a committed command once, then calibrate a 2-second room-state RTT");
  const host = await createPhone(browser, "QA Retry Host", phoneProfiles.iphone16);
  const guest = await createPhone(browser, "QA Retry Guest", phoneProfiles.proMax16);
  const commandBodies = [];
  let firstCommittedStatus = null;
  try {
    await Promise.all([openFreshHome(host), openFreshHome(guest)]);
    const room = await setupTwoPhoneRoom(host, guest, "mega");
    const openingView = await currentView(room.hostCredential);
    assert(openingView.phase === "drafting" && openingView.activeSeat, "Fault room did not assign a Mega starter");
    const starterSeat = openingView.activeSeat;
    const starterPhone = starterSeat === "a" ? host : guest;
    const opponentPhone = starterPhone === host ? guest : host;
    const starterCredential = starterSeat === "a" ? room.hostCredential : room.guestCredential;
    await waitForInteractiveBoard(starterPhone, 36);
    const pickPathname = `/api/arena/rooms/${room.roomId}/pick`;
    const pickPredicate = (url) => url.origin === new URL(baseUrl).origin && url.pathname === pickPathname;
    let resolveRetry;
    const retrySeen = new Promise((resolve) => { resolveRetry = resolve; });
    const pickHandler = async (route, request) => {
      if (request.method() !== "POST") return route.continue();
      const body = request.postDataJSON();
      commandBodies.push(body);
      if (commandBodies.length === 1) {
        const upstream = await route.fetch();
        firstCommittedStatus = upstream.status();
        starterPhone.collector.ignoreNetworkFailuresUntil = Date.now() + 5_000;
        starterPhone.collector.expectedNetworkConsoleErrors.push("ERR_CONNECTION_RESET");
        await route.abort("connectionreset");
        return;
      }
      resolveRetry();
      await route.continue();
    };
    await starterPhone.context.route(pickPredicate, pickHandler);
    await triggerPickWithoutWaiting(starterPhone);
    await Promise.race([retrySeen, sleep(8_000).then(() => { throw new Error("Client did not retry the lost committed pick response"); })]);
    await waitUntil(async () => (await currentView(starterCredential)).events.length === 1,
      "Retried committed pick did not settle to one server event", 8_000);
    await sleep(350);
    assert(commandBodies.length === 2, `Lost response generated ${commandBodies.length} pick attempts instead of exactly two`);
    assert(firstCommittedStatus === 200, `First upstream pick did not commit successfully (${firstCommittedStatus})`);
    assert(commandBodies[0]?.commandId && commandBodies[0].commandId === commandBodies[1]?.commandId,
      "Lost-response retry generated a different commandId");
    const afterRetry = await currentView(starterCredential);
    assert(afterRetry.events.length === 1 && afterRetry.participants.find((participant) => participant.seat === starterSeat)?.deckCount === 1,
      "Idempotent retry duplicated a pick or deck entry");
    await starterPhone.context.unroute(pickPredicate, pickHandler);

    const eventPathname = `/api/arena/rooms/${room.roomId}/events`;
    const statePathname = `/api/arena/rooms/${room.roomId}`;
    const eventPredicate = (url) => url.origin === new URL(baseUrl).origin && url.pathname === eventPathname;
    const statePredicate = (url) => url.origin === new URL(baseUrl).origin && url.pathname === statePathname;
    const abortEvents = (route) => route.abort("aborted");
    let timingSample = null;
    let resolveTiming;
    const timingDelivered = new Promise((resolve) => { resolveTiming = resolve; });
    const delayedState = async (route, request) => {
      if (request.method() !== "GET") return route.continue();
      const requestedAt = Date.now();
      const upstream = await route.fetch();
      const body = await upstream.json();
      await sleep(2_000);
      await route.fulfill({ response: upstream, contentType: "application/json", body: JSON.stringify(body) });
      const fulfilledAt = Date.now();
      if (!timingSample && body.events?.length >= 3 && body.activeSeat === starterSeat) {
        timingSample = { requestedAt, fulfilledAt, serverNow: body.serverNow, deadlineAt: body.deadlineAt, pickSeconds: body.settings.pickSeconds };
        resolveTiming();
      }
    };
    await starterPhone.context.route(eventPredicate, abortEvents);
    await starterPhone.context.route(statePredicate, delayedState);
    starterPhone.collector.ignoreNetworkFailuresUntil = Date.now() + 6_000;
    await starterPhone.page.reload({ waitUntil: "domcontentloaded" });
    await starterPhone.page.locator(".draft-stage").waitFor({ state: "visible", timeout: 8_000 });
    await performUiPick(opponentPhone);
    await opponentPhone.page.waitForFunction(() => document.querySelectorAll(".arena-cell.is-picked").length >= 2, null, { timeout: 5_000 });
    await performUiPick(opponentPhone);
    await Promise.race([timingDelivered, sleep(10_000).then(() => { throw new Error("No delayed post-pick room-state response reached the timer client"); })]);
    await starterPhone.page.locator(".draft-stage.is-local-turn .arena-timer.is-running").waitFor({ state: "visible", timeout: 5_000 });
    const measurement = await starterPhone.page.evaluate(() => {
      const timer = document.querySelector(".arena-timer-fill");
      const transform = timer?.getAttribute("style")?.match(/scaleX\(([-\d.]+)\)/)?.[1];
      return { measuredAt: Date.now(), ratio: transform === undefined ? null : Number(transform) };
    });
    assert(measurement.ratio !== null && measurement.ratio >= 0 && measurement.ratio <= 1, "Timer fill did not expose a valid remaining-time ratio");
    const live = await currentView(starterCredential);
    const rttMs = timingSample.fulfilledAt - timingSample.requestedAt;
    const displayedRemainingMs = measurement.ratio * timingSample.pickSeconds * 1_000;
    const actualRemainingMs = Math.max(0, live.deadlineAt - live.serverNow);
    const overclaimMs = displayedRemainingMs - actualRemainingMs;
    const naiveAtMeasurementMs = timingSample.deadlineAt - timingSample.serverNow - (measurement.measuredAt - timingSample.fulfilledAt);
    const correctionMs = naiveAtMeasurementMs - displayedRemainingMs;
    assert(rttMs >= 1_900, `Injected room-state RTT was only ${rttMs}ms`);
    assert(correctionMs >= Math.min(650, rttMs * 0.3),
      `Timer failed to correct a delayed room response: RTT ${rttMs}ms, correction ${Math.round(correctionMs)}ms`);
    assert(overclaimMs < 1_600,
      `Timer claimed ${Math.round(overclaimMs)}ms beyond the live server deadline after a ${rttMs}ms room-state RTT`);
    await screenshot(starterPhone, "fault-room-state-rtt-calibrated");
    await starterPhone.context.unroute(eventPredicate, abortEvents);
    await starterPhone.context.unroute(statePredicate, delayedState);
    assertPhoneClean(host);
    assertPhoneClean(guest);
    return {
      lostResponseRetry: { attempts: commandBodies.length, sameCommandId: true, serverEvents: afterRetry.events.length },
      timerCalibration: {
        injectedRttMs: rttMs,
        correctionMs: Math.round(correctionMs),
        deadlineOverclaimMs: Math.round(overclaimMs),
        avoidedFullRttOverclaim: true,
      },
    };
  } catch (error) {
    await Promise.allSettled([screenshot(host, "failure-fault-retry-timer-host"), screenshot(guest, "failure-fault-retry-timer-guest")]);
    summary.diagnostics.push(...host.collector.issues, ...guest.collector.issues);
    throw error;
  } finally {
    await Promise.allSettled([host.context.close(), guest.context.close()]);
  }
}

async function runFaultInjection(browser) {
  const pace = async () => {
    log("faults: wait for the shared-IP API rate window");
    await sleep(10_250);
  };
  await pace();
  const catalogRetry = await runCatalogRetryFault(browser);
  await pace();
  const lateAcknowledgement = await runLateAcknowledgementFault(browser);
  await pace();
  return { catalogRetry, lateAcknowledgement, ...(await runCommandRetryAndTimerFault(browser)) };
}

async function runMega(host, guest) {
  log("Mega: create and join through separate phone UIs");
  const room = await setupTwoPhoneRoom(host, guest, "mega", {
    exerciseCollection: true,
    exerciseLobbyControls: true,
    proveAssetHandshake: true,
    proveFailure: true,
  });
  const openingView = await currentView(room.hostCredential);
  assert(openingView.phase === "drafting" && openingView.activeSeat, "Mega did not assign an opening seat after loading");
  const openingPhone = openingView.activeSeat === "a" ? host : guest;
  const waitingPhone = openingPhone === host ? guest : host;
  await Promise.all([waitForInteractiveBoard(openingPhone, 36), waitForInteractiveBoard(waitingPhone, 36, { requireEnabled: false })]);
  const initialPositions = await megaPositions(host);
  assert(initialPositions.length === 36, `Mega rendered ${initialPositions.length} positions instead of 36`);
  assert(JSON.stringify(initialPositions) === JSON.stringify(await megaPositions(guest)), "Mega phones did not receive the same initial fixed board");
  const privacy = await assertPrivacy(room.roomId, room.hostCredential, room.guestCredential, "mega");
  const megaSettings = (await currentView(room.hostCredential)).settings;
  assert(megaSettings.timerMode === "per_pick" && megaSettings.pickSeconds === 15,
    `Mega did not use the native 15-second per-pick clock: ${JSON.stringify(megaSettings)}`);
  const layoutProfiles = [];
  layoutProfiles.push(await assertAtProfile(host, "iphone16", "Mega iPhone 16 before picks", "mega-start-iphone16"));
  layoutProfiles.push(await assertAtProfile(guest, "proMax16", "Mega iPhone 16 Pro Max before picks", "mega-start-promax16"));
  layoutProfiles.push(await assertAtProfile(host, "legacy", "Mega 320px legacy viewport before picks", "mega-start-legacy-320x568"));
  layoutProfiles.push(await assertAtProfile(guest, "reducedSafari", "Mega reduced Safari viewport before picks", "mega-start-safari-393x660"));
  await Promise.all([
    host.page.setViewportSize(phoneProfiles.iphone16.viewport),
    guest.page.setViewportSize(phoneProfiles.proMax16.viewport),
  ]);
  await exerciseFailedPickUi(openingPhone, room.roomId);

  const picks = [];
  let chooserCount = 0;
  let specialFormCount = 0;
  let completionPresentation = null;
  let fallbackProof = null;
  let fallbackPhone = null;
  let removePinnedPolling = [];
  let polledPickCount = 0;
  for (let index = 0; index < 16; index += 1) {
    const hostView = await currentView(room.hostCredential);
    assert(hostView.phase === "drafting" && hostView.activeSeat, `Mega ended before pick ${index + 1}`);
    const phone = hostView.activeSeat === "a" ? host : guest;
    if (index === 0 && transport === "sse") {
      fallbackPhone = phone === host ? guest : host;
      fallbackProof = await forceSseFallbackToPolling(fallbackPhone, room.roomId);
    }
    if (index === 15) {
      await Promise.all([host, guest].map((candidate) => candidate.page.waitForFunction(
        () => document.querySelectorAll(".arena-flying-card").length === 0,
        undefined,
        { timeout: 2_000 },
      )));
    }
    const result = await performUiPick(phone);
    const event = result.body.events?.at(-1);
    assert(event && event.automatic === false, `Mega pick ${index + 1} was not recorded as an accepted human pick`);
    result.cardKey ??= event.cardKey;
    result.position ??= event.position;
    chooserCount += Number(result.usedChooser);
    specialFormCount += Number(["evolution", "hero", "champion"].includes(event.form));
    const convergence = await waitMegaConvergence(host, guest, result, phone);
    if (transport === "polling") {
      assert(convergence.polling !== null && convergence.polling !== undefined, `Mega pick ${index + 1} lacked HTTP poll convergence evidence`);
      polledPickCount += 1;
    }
    if (convergence.phase === "drafting") {
      assert(JSON.stringify(await megaPositions(host)) === JSON.stringify(initialPositions), `Mega host board positions changed after pick ${index + 1}`);
      assert(JSON.stringify(await megaPositions(guest)) === JSON.stringify(initialPositions), `Mega guest board positions changed after pick ${index + 1}`);
    } else {
      completionPresentation = { livePresentationMs: convergence.presentationMs, perPhone: convergence.perPhone ?? null };
    }
    picks.push({ number: index + 1, seat: event.seat, cardKey: event.cardKey, form: event.form, position: event.position });
    if (index === 0 && transport === "sse") {
      await fallbackPhone.page.locator(".connection-banner").waitFor({ state: "hidden", timeout: 4_000 });
      await fallbackProof.restore();
      const staleHost = await currentView(room.hostCredential);
      const staleGuest = await currentView(room.guestCredential);
      removePinnedPolling = await Promise.all([
        pinRoomPolling(host, room.hostCredential, staleHost),
        pinRoomPolling(guest, room.guestCredential, staleGuest),
      ]);
      await sleep(250);
    }
    if (index === 3) {
      await screenshot(guest, "mega-four-picks-promax");
      await Promise.all(removePinnedPolling.map((remove) => remove()));
      removePinnedPolling = [];
      await reloadAndAssertResume(host, room.hostCredential, result.body.revision, 4);
    }
    if (index === 7) await Promise.all([assertLayout(host, "Mega iPhone 16 midpoint"), assertLayout(guest, "Mega iPhone 16 Pro Max midpoint")]);
    await sleep(360);
  }
  await Promise.all([
    host.page.getByRole("heading", { name: "Deck ready!" }).waitFor({ timeout: 5_000 }),
    guest.page.getByRole("heading", { name: "Deck ready!" }).waitFor({ timeout: 5_000 }),
  ]);
  const [hostFinal, guestFinal] = await Promise.all([currentView(room.hostCredential), currentView(room.guestCredential)]);
  const hostIds = assertExport(hostFinal, "Mega host");
  const guestIds = assertExport(guestFinal, "Mega guest");
  assert(chooserCount > 0, "Mega never rendered a form chooser for an available form");
  assert(specialFormCount > 0, "Mega completed without selecting an Evolution, Hero, or Champion form");
  assert(await host.page.locator(".finished-card").count() === 8, "Mega host completion UI does not render eight cards");
  assert(await guest.page.locator(".finished-card").count() === 8, "Mega guest completion UI does not render eight cards");
  await Promise.all([assertLayout(host, "Mega iPhone 16 completion"), assertLayout(guest, "Mega iPhone 16 Pro Max completion")]);
  await Promise.all([screenshot(host, "mega-complete-iphone16"), screenshot(guest, "mega-complete-promax16")]);
  assert(completionPresentation !== null, "Mega did not verify the bounded final-pick live transition");
  completionPresentation.completedReload = await reloadCompletedRoomImmediately(host, room.hostCredential);
  if (transport === "polling") {
    assert(polledPickCount === 16, `Polling proved ${polledPickCount}/16 accepted pick revisions`);
    assert(host.collector.streamRequests.length === 0 && guest.collector.streamRequests.length === 0,
      `Polling preview opened SSE requests (host ${host.collector.streamRequests.length}, guest ${guest.collector.streamRequests.length})`);
  }
  return {
    roomId: room.roomId,
    acceptedPicks: picks.length,
    chooserCount,
    specialFormCount,
    fixedPositions: initialPositions.length,
    hostDeckIds: hostIds,
    guestDeckIds: guestIds,
    privacy,
    sse: transport === "sse"
      ? { host: true, guest: true, convergenceWithoutFreshGet: true }
      : { host: false, guest: false, noRequestsObserved: true },
    polling: transport === "polling" ? { provedAcceptedPickRevisions: polledPickCount, intervalMs: 1_000 } : null,
    pollingFallback: transport === "sse"
      ? { provedAfterSseInterruption: true, restoredSse: true, intentionalNetworkFaults: fallbackPhone?.collector.intentionalNetworkFaults ?? 0 }
      : null,
    loadingHandshake: room.loadingHandshake,
    lobbyControls: room.lobbyControls,
    timer: { mode: megaSettings.timerMode, seconds: megaSettings.pickSeconds },
    completionTransition: completionPresentation,
    layoutProfiles,
    reloadResume: true,
  };
}

async function backHome(phone) {
  const button = phone.page.locator("button.text-button", { hasText: "Back to home" });
  await button.click();
  await waitForHome(phone);
}

async function runPrivateMode(host, guest, mode) {
  log(`${mode}: run both private lanes concurrently through UI`);
  await Promise.all([backHome(host), backHome(guest)]);
  const room = await setupTwoPhoneRoom(host, guest, mode);
  const boardSize = mode === "classic" ? 2 : 6;
  const rounds = mode === "classic" ? 4 : 8;
  await Promise.all([waitForInteractiveBoard(host, boardSize), waitForInteractiveBoard(guest, boardSize)]);
  const privacy = await assertPrivacy(room.roomId, room.hostCredential, room.guestCredential, mode);
  const privateSettings = (await currentView(room.hostCredential)).settings;
  assert(privateSettings.timerMode === "whole_draft" && privateSettings.pickSeconds === 60,
    `${mode} did not use the native 60-second whole-draft clock: ${JSON.stringify(privateSettings)}`);
  const pairs = [];
  let chooserCount = 0;
  for (let round = 1; round <= rounds; round += 1) {
    const [hostPick, guestPick] = await Promise.all([performUiPick(host), performUiPick(guest)]);
    const launchSkewMs = Math.abs(hostPick.submittedAt - guestPick.submittedAt);
    assert(launchSkewMs < 800, `${mode} round ${round} was not simultaneous enough (${launchSkewMs}ms submit skew)`);
    chooserCount += Number(hostPick.usedChooser) + Number(guestPick.usedChooser);
    pairs.push({ round, launchSkewMs, hostRevision: hostPick.body.revision, guestRevision: guestPick.body.revision });
    if (round < rounds) {
      await Promise.all([waitForInteractiveBoard(host, boardSize), waitForInteractiveBoard(guest, boardSize)]);
      const [hostView, guestView] = await Promise.all([currentView(room.hostCredential), currentView(room.guestCredential)]);
      assert(hostView.revision === guestView.revision, `${mode} views did not converge after round ${round}`);
      assert(hostView.events.length === round && guestView.events.length === round, `${mode} exposed the wrong private event count after round ${round}`);
      if (mode === "triple") {
        assert(hostView.participants.find((participant) => participant.seat === "b")?.deck.length === 0, "triple host saw the guest's actual picks");
        assert(guestView.participants.find((participant) => participant.seat === "a")?.deck.length === 0, "triple guest saw the host's actual picks");
      } else {
        for (const view of [hostView, guestView]) {
          const viewer = view.participants.find((participant) => participant.seat === view.viewer);
          const opponent = view.participants.find((participant) => participant.seat !== view.viewer);
          assert(viewer?.deck.length === round && opponent?.deck.length === round,
            `classic ${view.viewer} did not expose exactly the ${round} cards they selected and gave away`);
          assert(viewer?.deckCount === round * 2 && opponent?.deckCount === round * 2,
            `classic ${view.viewer} deck counts do not include ${round} concealed received cards`);
        }
        for (const phone of [host, guest]) {
          const counts = await phone.page.evaluate(() => ({
            viewerFaces: document.querySelectorAll(".arena-tray.is-viewer .arena-card-face").length,
            viewerBacks: document.querySelectorAll(".arena-tray.is-viewer .arena-card-back").length,
            opponentFaces: document.querySelectorAll(".arena-tray.is-opponent .arena-card-face").length,
            opponentBacks: document.querySelectorAll(".arena-tray.is-opponent .arena-card-back").length,
          }));
          assert(counts.viewerFaces === round && counts.viewerBacks === round,
            `classic ${phone.label} viewer tray did not keep received cards concealed: ${JSON.stringify(counts)}`);
          assert(counts.opponentFaces === round && counts.opponentBacks === round,
            `classic ${phone.label} opponent tray did not show known given cards with unknown received cards concealed: ${JSON.stringify(counts)}`);
        }
      }
    }
    if (round === 1) {
      await Promise.all([assertLayout(host, `${mode} iPhone 16 drafting`), assertLayout(guest, `${mode} iPhone 16 Pro Max drafting`)]);
      await Promise.all([screenshot(host, `${mode}-private-host`), screenshot(guest, `${mode}-private-guest`)]);
    }
    await sleep(320);
  }
  await Promise.all([
    host.page.getByRole("heading", { name: "Deck ready!" }).waitFor({ timeout: 5_000 }),
    guest.page.getByRole("heading", { name: "Deck ready!" }).waitFor({ timeout: 5_000 }),
  ]);
  const [hostFinal, guestFinal] = await Promise.all([currentView(room.hostCredential), currentView(room.guestCredential)]);
  const hostIds = assertExport(hostFinal, `${mode} host`);
  const guestIds = assertExport(guestFinal, `${mode} guest`);
  assert(hostFinal.events.length === rounds, `${mode} final event count is ${hostFinal.events.length}`);
  assert(guestFinal.events.length === hostFinal.events.length, `${mode} final views disagree on event count`);
  await Promise.all([assertLayout(host, `${mode} iPhone 16 completion`), assertLayout(guest, `${mode} iPhone 16 Pro Max completion`)]);
  await screenshot(host, `${mode}-complete-iphone16`);
  return {
    roomId: room.roomId,
    simultaneousRounds: rounds,
    chooserCount,
    pairs,
    hostDeckIds: hostIds,
    guestDeckIds: guestIds,
    privacy,
    timer: { mode: privateSettings.timerMode, seconds: privateSettings.pickSeconds },
  };
}

async function runPractice(browser) {
  log("practice: complete a full Triple draft with the bot lane");
  const phone = await createPhone(browser, "QA Practice", phoneProfiles.iphone16);
  try {
    await openFreshHome(phone);
    await configureHome(phone, "triple");
    await phone.page.getByRole("button", { name: /Practice draft/i }).click();
    await phone.page.locator(".draft-stage").waitFor();
    const roomId = decodeURIComponent(new URL(phone.page.url()).hash.match(/^#room=(.+)$/)?.[1] ?? "");
    const credential = await savedCredential(phone, roomId);
    await waitForStream(phone, roomId);
    const initial = await currentView(credential);
    assert(initial.settings.timerMode === "whole_draft" && initial.settings.pickSeconds === 60,
      `Practice Triple did not use the native 60-second whole-draft clock: ${JSON.stringify(initial.settings)}`);
    let humanPicks = 0;
    while (humanPicks < 8) {
      const view = await currentView(credential);
      if (view.phase === "complete") break;
      await waitForInteractiveBoard(phone, 6);
      await performUiPick(phone);
      humanPicks += 1;
      await sleep(280);
    }
    await phone.page.getByRole("heading", { name: "Deck ready!" }).waitFor({ timeout: 15_000 });
    const final = await currentView(credential);
    assertExport(final, "Practice bot host");
    const botEvents = final.events.filter((event) => event.seat === "b" && event.automatic);
    const botParticipant = final.participants.find((participant) => participant.bot);
    assert(humanPicks === 8, `Practice human completed ${humanPicks} picks instead of 8`);
    assert(botEvents.length === 0, `Practice exposed ${botEvents.length} private bot pick events to the human`);
    assert(botParticipant?.deckCount === 8, `Practice bot completed ${botParticipant?.deckCount ?? 0} picks instead of 8`);
    await assertLayout(phone, "Practice phone completion");
    await screenshot(phone, "practice-bot-complete");
    assertPhoneClean(phone);
    return { roomId, humanPicks, automaticBotPicks: botParticipant.deckCount, privateBotEventsExposed: botEvents.length, timer: { mode: initial.settings.timerMode, seconds: initial.settings.pickSeconds } };
  } catch (error) {
    await screenshot(phone, "failure-practice").catch(() => undefined);
    summary.diagnostics.push(...phone.collector.issues);
    throw error;
  } finally {
    await phone.context.close();
  }
}

function assertPhoneClean(phone) {
  const unmet = phone.collector.expectedResponses.filter((item) => item.remaining > 0);
  if (unmet.length) phone.collector.issues.push(`${phone.label} did not observe expected HTTP responses: ${JSON.stringify(unmet)}`);
  const fontResponse = phone.collector.assetResponses.find((item) => item.pathname === "/assets/royale/ui/supercell-magic.woff2" && item.status < 400);
  if (!fontResponse) phone.collector.issues.push(`${phone.label} did not fetch the local Supercell font successfully`);
  const webpCards = phone.collector.assetResponses.filter((item) => item.pathname.startsWith("/assets/royale/cards/") && item.pathname.endsWith(".webp") && item.status < 400);
  if (webpCards.length === 0) phone.collector.issues.push(`${phone.label} did not fetch any WebP card artwork`);
  assert(phone.collector.issues.length === 0, phone.collector.issues.join("\n"));
}

async function runFull(browser) {
  if (scope === "full") {
    log("full: wait for a clean shared-IP API rate window");
    await sleep(10_250);
  }
  const host = await createPhone(browser, "QA Host", phoneProfiles.iphone16);
  const guest = await createPhone(browser, "QA Guest", phoneProfiles.proMax16);
  try {
    await Promise.all([openFreshHome(host), openFreshHome(guest)]);
    summary.flows.mega = await runMega(host, guest);
    if (scope === "full") {
      await sleep(10_250);
      summary.flows.classic = await runPrivateMode(host, guest, "classic");
      await sleep(10_250);
      summary.flows.triple = await runPrivateMode(host, guest, "triple");
    }
    assertPhoneClean(host);
    assertPhoneClean(guest);
    summary.assetTransport = {
      hostResponses: host.collector.assetResponses.length,
      guestResponses: guest.collector.assetResponses.length,
      hostWebpCards: host.collector.assetResponses.filter((item) => item.pathname.endsWith(".webp") && item.pathname.includes("/cards/")).length,
      guestWebpCards: guest.collector.assetResponses.filter((item) => item.pathname.endsWith(".webp") && item.pathname.includes("/cards/")).length,
      missingOrFailed: 0,
    };
  } catch (error) {
    await Promise.allSettled([screenshot(host, "failure-host"), screenshot(guest, "failure-guest")]);
    summary.diagnostics.push(...host.collector.issues, ...guest.collector.issues);
    throw error;
  } finally {
    await Promise.allSettled([host.context.close(), guest.context.close()]);
  }
  if (scope === "full") {
    log("full: wait for the shared-IP API rate window before practice");
    await sleep(10_250);
    summary.flows.practice = await runPractice(browser);
    summary.flows.faults = await runFaultInjection(browser);
  }
}

async function main() {
  assert(["full", "mega", "faults"].includes(scope), `ARENA_QA_SCOPE must be "full", "mega", or "faults", received ${scope}`);
  assert(["sse", "polling"].includes(transport), `ARENA_QA_TRANSPORT must be "sse" or "polling", received ${transport}`);
  assert(transport !== "polling" || scope === "mega", "ARENA_QA_TRANSPORT=polling is a bounded Mega preview profile; set ARENA_QA_SCOPE=mega");
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });
  const executablePath = await resolveBrowserExecutable();
  summary.browser.path = executablePath;
  summary.server = await requireHealthyServer();
  log(`launching isolated headless Chromium: ${executablePath}`);
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    if (scope === "faults") summary.flows.faults = await runFaultInjection(browser);
    else await runFull(browser);
    summary.ok = true;
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (error) {
  summary.failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) };
  process.exitCode = 1;
} finally {
  await writeSummary();
  console.log(JSON.stringify({ ok: summary.ok, summary: path.relative(process.cwd(), summaryPath), failure: summary.failure?.message ?? null }, null, 2));
}
