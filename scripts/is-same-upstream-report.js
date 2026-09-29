// Exit 0 when two upstream reports are the same report, 1 when they differ.
// The comparison lives in format-upstream-issue.js, where it is unit tested
// against the exact bytes the workflow's round trip through GitHub produces.
import fs from "node:fs/promises";

import { isSameReport } from "./format-upstream-issue.js";

const [previousPath, nextPath] = process.argv.slice(2);
if ( !previousPath || !nextPath ) {
  console.error("Usage: node scripts/is-same-upstream-report.js <previous.md> <next.md>");
  process.exit(2);
}

const read = (file) => fs.readFile(file, "utf8").catch(() => "");
const [previous, next] = await Promise.all([read(previousPath), read(nextPath)]);
process.exit(isSameReport(previous, next) ? 0 : 1);
