#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { diff, evaluate, parseSbom } from "./diff.js";

const USAGE = `usage: sbom-diff <before.json> <after.json> [--json] [--deny-license ID]... [--fail-on-downgrade] [--fail-on-added]
Compares two CycloneDX JSON SBOMs. Exit 1 when a policy flag is violated, 2 on bad input.`;

function main(argv: string[]): number {
  const files: string[] = [];
  const deny: string[] = [];
  let json = false, downgrade = false, added = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "--fail-on-downgrade") downgrade = true;
    else if (a === "--fail-on-added") added = true;
    else if (a === "--deny-license") { const v = argv[++i]; if (!v) { console.error(USAGE); return 2; } deny.push(v); }
    else if (a.startsWith("-")) { console.error(USAGE); return 2; }
    else files.push(a);
  }
  if (files.length !== 2) { console.error(USAGE); return 2; }
  let d;
  try {
    d = diff(parseSbom(readFileSync(files[0]!, "utf8")), parseSbom(readFileSync(files[1]!, "utf8")));
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 2;
  }
  const violations = evaluate(d, { denyLicenses: deny, failOnDowngrade: downgrade, failOnAdded: added });
  if (json) {
    console.log(JSON.stringify({ ...d, violations }, null, 2));
  } else {
    for (const c of d.added) console.log(`+ ${c.name} ${c.version}${c.licenses.length ? `  [${c.licenses.join(", ")}]` : ""}`);
    for (const c of d.removed) console.log(`- ${c.name} ${c.version}`);
    for (const c of d.changed) console.log(`${c.direction === "upgrade" ? "^" : c.direction === "downgrade" ? "v" : "~"} ${c.name} ${c.from} -> ${c.to}${c.direction === "downgrade" ? "  (DOWNGRADE)" : ""}`);
    for (const l of d.licenseChanges) console.log(`L ${l.name} ${l.version}: ${l.from.join(", ") || "none"} -> ${l.to.join(", ") || "none"}`);
    console.log(`\n${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed, ${d.licenseChanges.length} license change(s), ${d.unchanged} unchanged`);
    for (const v of violations) console.log(`POLICY ${v.code}: ${v.message}`);
  }
  return violations.length ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
