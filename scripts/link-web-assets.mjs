import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const sourceAssets = path.join(repoRoot, "public/assets");
const webPublic = path.join(repoRoot, "apps/web/public");
const webAssets = path.join(webPublic, "assets");
const relativeTarget = path.relative(webPublic, sourceAssets);

if (!fs.existsSync(sourceAssets)) {
  throw new Error(`Missing source assets directory: ${sourceAssets}`);
}

fs.mkdirSync(webPublic, { recursive: true });

if (fs.existsSync(webAssets)) {
  const stat = fs.lstatSync(webAssets);
  if (stat.isSymbolicLink()) {
    const currentTarget = fs.readlinkSync(webAssets);
    if (currentTarget === relativeTarget) {
      console.log(`web assets linked: ${webAssets} -> ${relativeTarget}`);
      process.exit(0);
    }
    fs.unlinkSync(webAssets);
  } else if (stat.isDirectory()) {
    console.log(`web assets directory exists: ${webAssets}`);
    process.exit(0);
  } else {
    throw new Error(`Cannot link assets; non-directory path exists: ${webAssets}`);
  }
}

fs.symlinkSync(relativeTarget, webAssets, "dir");
console.log(`web assets linked: ${webAssets} -> ${relativeTarget}`);
