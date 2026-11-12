import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { compareVersions, diff, evaluate, identity, parseSbom, type Component } from "../src/index.js";

const SAMPLES = join(import.meta.dirname, "..", "..", "samples");
const c = (name: string, version: string, licenses: string[] = [], purlType = "npm"): Component =>
  ({ key: `pkg:${purlType}/${name}`, name, version, licenses, purl: `pkg:${purlType}/${name}@${version}` });
const none = { denyLicenses: [], failOnDowngrade: false, failOnAdded: false };

test("version comparison", () => {
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("v2.0", "2.0.0"), 0);
  assert.equal(compareVersions("1.0.0-beta", "1.0.0"), -1);
  assert.equal(compareVersions("4.17.21", "4.17.20"), 1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
});

test("identity strips version and qualifiers from purl", () => {
  assert.equal(identity({ purl: "pkg:npm/%40scope/pkg@1.2.3?arch=x86" }), "pkg:npm/%40scope/pkg");
  assert.equal(identity({ group: "org.apache", name: "commons" }), "org.apache/commons");
  assert.equal(identity({ name: "solo" }), "solo");
});

test("added, removed, upgraded, downgraded", () => {
  const d = diff(
    [c("a", "1.0.0"), c("b", "2.0.0"), c("gone", "1.0.0"), c("same", "1.0.0")],
    [c("a", "1.1.0"), c("b", "1.9.0"), c("new", "0.1.0"), c("same", "1.0.0")],
  );
  assert.deepEqual(d.added.map((x) => x.name), ["new"]);
  assert.deepEqual(d.removed.map((x) => x.name), ["gone"]);
  assert.deepEqual(d.changed.map((x) => [x.name, x.direction]), [["a", "upgrade"], ["b", "downgrade"]]);
  assert.equal(d.unchanged, 1);
});

test("license changes are detected only for the same version", () => {
  const d = diff([c("x", "1.0.0", ["MIT"]), c("y", "1.0.0", ["MIT"])], [c("x", "1.0.0", ["GPL-3.0-only"]), c("y", "2.0.0", ["GPL-3.0-only"])]);
  assert.equal(d.licenseChanges.length, 1);
  assert.deepEqual(d.licenseChanges[0]?.to, ["GPL-3.0-only"]);
  assert.equal(d.changed.length, 1, "version change of y is a change, not a license change");
});

test("a component can appear in several versions", () => {
  const d = diff([c("multi", "1.0.0"), c("multi", "2.0.0")], [c("multi", "2.0.0"), c("multi", "3.0.0")]);
  assert.deepEqual(d.changed.map((x) => [x.from, x.to]), [["1.0.0", "3.0.0"]]);
  assert.equal(d.unchanged, 1);
  assert.equal(d.added.length + d.removed.length, 0);
});

test("same name in different ecosystems stays separate", () => {
  const d = diff([c("requests", "1.0.0", [], "pypi")], [c("requests", "1.0.0", [], "npm")]);
  assert.equal(d.added.length, 1);
  assert.equal(d.removed.length, 1);
});

test("policy: denied licences, downgrades and new components", () => {
  const d = diff([c("a", "2.0.0", ["MIT"]), c("l", "1.0.0", ["MIT"])], [c("a", "1.0.0", ["MIT"]), c("l", "1.0.0", ["AGPL-3.0-only"]), c("n", "1.0.0", ["AGPL-3.0-only"])]);
  const codes = evaluate(d, { denyLicenses: ["agpl-3.0-only"], failOnDowngrade: true, failOnAdded: true }).map((v) => v.code).sort();
  assert.deepEqual(codes, ["DENIED_LICENSE", "DOWNGRADE", "LICENSE_CHANGED_TO_DENIED", "NEW_COMPONENTS"]);
  assert.deepEqual(evaluate(d, none), []);
});

test("parser: nested components, license shapes and rejection of other formats", () => {
  const sbom = JSON.stringify({
    bomFormat: "CycloneDX",
    components: [
      { name: "outer", version: "1", components: [{ name: "inner", version: "2", licenses: [{ expression: "MIT OR Apache-2.0" }, { license: { name: "Custom" } }] }] },
      { version: "no-name" },
      "garbage",
    ],
  });
  const comps = parseSbom(sbom);
  assert.deepEqual(comps.map((x) => x.name), ["outer", "inner"]);
  assert.deepEqual(comps[1]?.licenses, ["Custom", "MIT OR Apache-2.0"]);
  assert.throws(() => parseSbom("{ nope"), /invalid JSON/);
  assert.throws(() => parseSbom(JSON.stringify({ spdxVersion: "SPDX-2.3" })), /not a CycloneDX/);
  assert.deepEqual(parseSbom(JSON.stringify({ bomFormat: "CycloneDX" })), []);
});

test("parser survives pathological nesting", () => {
  let inner: Record<string, unknown> = { name: "leaf", version: "1" };
  for (let i = 0; i < 200; i++) inner = { name: `n${i}`, version: "1", components: [inner] };
  const comps = parseSbom(JSON.stringify({ bomFormat: "CycloneDX", components: [inner] }));
  assert.ok(comps.length <= 22, "depth is capped");
});

test("CLI end to end on the samples", () => {
  const cli = join(import.meta.dirname, "..", "src", "cli.js");
  const run = (...args: string[]) => spawnSync("node", [cli, ...args], { encoding: "utf8" });
  const plain = run(join(SAMPLES, "before.cdx.json"), join(SAMPLES, "after.cdx.json"));
  assert.equal(plain.status, 0);
  assert.match(plain.stdout, /\+ mongodb-driver 5\.0\.0/);
  assert.match(plain.stdout, /- left-pad 1\.3\.0/);
  assert.match(plain.stdout, /\^ lodash 4\.17\.20 -> 4\.17\.21/);
  assert.match(plain.stdout, /v express 4\.18\.2 -> 4\.17\.1 {2}\(DOWNGRADE\)/);
  const gated = run(join(SAMPLES, "before.cdx.json"), join(SAMPLES, "after.cdx.json"), "--deny-license", "AGPL-3.0-only", "--fail-on-downgrade");
  assert.equal(gated.status, 1);
  assert.match(gated.stdout, /DENIED_LICENSE/);
  assert.match(gated.stdout, /DOWNGRADE/);
  const json = JSON.parse(run("--json", join(SAMPLES, "before.cdx.json"), join(SAMPLES, "after.cdx.json")).stdout);
  assert.equal(json.added.length, 1);
  assert.equal(run().status, 2);
  assert.equal(run("/nope.json", "/nope2.json").status, 2);
});
