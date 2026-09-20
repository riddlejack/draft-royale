import { fileURLToPath } from "node:url";
import path from "node:path";

export const repoRoot = process.env.DRAFT_ROYALE_ROOT
  ? path.resolve(process.env.DRAFT_ROYALE_ROOT)
  : path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export const serverPort = Number(process.env.PORT ?? 4141);
