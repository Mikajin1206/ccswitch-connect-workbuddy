#!/usr/bin/env node
/**
 * Give the bundled gateway the filename the app actually looks for.
 *
 *   node scripts/rename-gateway-output.mjs
 *
 * WHY THIS EXISTS. `package.json` used to finish the build with
 * `mv lib/mac-gateway.mjs lib/macGateway.js`. `mv` is a POSIX coreutil: on
 * Windows `npm run build` stopped at
 *
 *   'mv' is not recognized as an internal or external command
 *
 * *after* tsdown had already written 507 kB of bundle, so the build "failed"
 * while leaving a correct-but-misnamed artifact behind. Anything that reads
 * `lib/macGateway.js` — `GatewayController.swift`, the packaging step in
 * `macos/build-app.sh`, a developer poking at the bundle — then found nothing.
 * This repository treats Windows as a first-class target (see `.gitattributes`),
 * so the build script must not depend on which shell family happens to run it.
 *
 * WHY NOT `tsdown --out-extension` / entry renaming. tsdown derives the output
 * name from the entry file, so `src/mac-gateway.ts` becomes `mac-gateway.mjs`
 * no matter what the flag is called. Renaming the entry to `macGateway.ts`
 * would work, but it renames the SOURCE module that every import in `src/`
 * refers to, for a packaging concern. The rename is a build step; keep it in
 * one place, in Node, where every platform agrees on what it means.
 */
import { existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repoRoot, 'lib', 'mac-gateway.mjs');
const target = join(repoRoot, 'lib', 'macGateway.js');

if (!existsSync(source)) {
  // A silent no-op here would ship an app with no gateway in it, which is
  // exactly the failure mode this script was written to remove.
  console.error(`未找到 tsdown 产物：${source}（先跑 tsdown，再跑本脚本）`);
  process.exit(1);
}

// `renameSync` refuses to overwrite on some platforms; the tsdown `--clean`
// flag normally clears `lib/` first, but a stale artifact must not wedge a
// rebuild.
if (existsSync(target)) rmSync(target);
renameSync(source, target);

console.log(`已重命名：lib/mac-gateway.mjs → lib/macGateway.js`);
