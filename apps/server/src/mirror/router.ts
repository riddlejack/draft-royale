import express, { type Request, type RequestHandler, type Router } from "express";
import { MirrorRoomError, type MirrorRoomService } from "./service.js";

const maxBodyBytes = 64 * 1024;

const tokenFromHeader = (request: Request) => {
  const match = request.header("authorization")?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]?.trim()) throw new MirrorRoomError(401, "Bearer room credentials are required.", "UNAUTHORIZED");
  return match[1].trim();
};

const requestGuard: RequestHandler = (request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  const contentLength = Number(request.header("content-length") ?? 0);
  const parsedBytes = request.body === undefined ? 0 : Buffer.byteLength(JSON.stringify(request.body));
  if ((Number.isFinite(contentLength) && contentLength > maxBodyBytes) || parsedBytes > maxBodyBytes) {
    response.status(413).json({ error: "Request body is too large.", code: "BODY_TOO_LARGE" });
    return;
  }
  next();
};

export const createMirrorRoomRouter = (service: MirrorRoomService): Router => {
  const router = express.Router();
  router.use("/api/mirror", requestGuard);
  router.post("/api/mirror/rooms", (request, response) => response.status(201).json(service.create(request.body ?? {})));
  router.post("/api/mirror/join", (request, response) => response.status(201).json(service.join(request.body ?? {})));
  router.get("/api/mirror/rooms/:id", (request, response) => response.json({ room: service.get(String(request.params.id), tokenFromHeader(request)) }));
  router.post("/api/mirror/rooms/:id/command", (request, response) => response.json({ room: service.command(String(request.params.id), tokenFromHeader(request), request.body ?? {}) }));
  router.use((error: unknown, _request: Request, response: express.Response, next: express.NextFunction) => {
    if (error instanceof MirrorRoomError) {
      response.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    next(error);
  });
  return router;
};
