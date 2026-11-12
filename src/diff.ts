export interface Component {
  key: string;
  name: string;
  group?: string;
  version: string;
  purl?: string;
  licenses: string[];
}

export interface Change {
  key: string;
  name: string;
  from: string;
  to: string;
  direction: "upgrade" | "downgrade" | "change";
}

export interface LicenseChange { key: string; name: string; version: string; from: string[]; to: string[] }

export interface Diff {
  added: Component[];
  removed: Component[];
  changed: Change[];
  licenseChanges: LicenseChange[];
  unchanged: number;
}

type Json = Record<string, any>;

/** Compare dotted numeric versions; falls back to string comparison for non-numeric parts. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(/[.+-]/);
  const pb = b.replace(/^v/i, "").split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (x !== y) {
      if (nx !== ny) return nx ? 1 : -1; // numeric segment beats a pre-release label
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Identity of a component independent of its version: purl without the version, otherwise group/name. */
export function identity(c: Json): string {
  const purl = typeof c.purl === "string" ? c.purl : "";
  if (purl) return purl.replace(/@[^?#]*/, "").split("?")[0] ?? purl;
  return [c.group, c.name].filter(Boolean).join("/");
}

function licenseNames(c: Json): string[] {
  const out: string[] = [];
  for (const l of (c.licenses as Json[] | undefined) ?? []) {
    const v = l.license?.id ?? l.license?.name ?? l.expression;
    if (typeof v === "string") out.push(v);
  }
  return out.sort();
}

/** Parse a CycloneDX JSON document into a flat component list (nested components are flattened). */
export function parseSbom(text: string): Component[] {
  let doc: Json;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid JSON: ${(e as Error).message}`);
  }
  if (doc?.bomFormat !== "CycloneDX") throw new Error("not a CycloneDX document (bomFormat must be CycloneDX)");
  const out: Component[] = [];
  const walk = (list: Json[] | undefined, depth: number) => {
    if (!Array.isArray(list) || depth > 20) return;
    for (const c of list) {
      if (!c || typeof c !== "object" || typeof c.name !== "string") continue;
      out.push({ key: identity(c), name: c.name, group: c.group, version: String(c.version ?? ""), purl: c.purl, licenses: licenseNames(c) });
      walk(c.components, depth + 1);
    }
  };
  walk(doc.components, 0);
  return out;
}

export function diff(before: Component[], after: Component[]): Diff {
  const group = (list: Component[]) => {
    const m = new Map<string, Component[]>();
    for (const c of list) m.set(c.key, [...(m.get(c.key) ?? []), c]);
    return m;
  };
  const b = group(before), a = group(after);
  const d: Diff = { added: [], removed: [], changed: [], licenseChanges: [], unchanged: 0 };
  for (const [key, news] of a) {
    const olds = b.get(key);
    if (!olds) { d.added.push(...news); continue; }
    const oldVersions = new Set(olds.map((c) => c.version));
    const newVersions = new Set(news.map((c) => c.version));
    const gone = olds.filter((c) => !newVersions.has(c.version));
    const fresh = news.filter((c) => !oldVersions.has(c.version));
    // pair replaced versions in order so multi-version components still report sensibly
    for (let i = 0; i < Math.max(gone.length, fresh.length); i++) {
      const o = gone[i], n = fresh[i];
      if (o && n) d.changed.push({ key, name: n.name, from: o.version, to: n.version, direction: compareVersions(n.version, o.version) > 0 ? "upgrade" : compareVersions(n.version, o.version) < 0 ? "downgrade" : "change" });
      else if (n) d.added.push(n);
      else if (o) d.removed.push(o);
    }
    for (const n of news) {
      const o = olds.find((c) => c.version === n.version);
      if (!o) continue;
      if (o.licenses.join("|") !== n.licenses.join("|")) d.licenseChanges.push({ key, name: n.name, version: n.version, from: o.licenses, to: n.licenses });
      else d.unchanged++;
    }
  }
  for (const [key, olds] of b) if (!a.has(key)) d.removed.push(...olds);
  const byName = (x: { name: string }, y: { name: string }) => x.name.localeCompare(y.name);
  d.added.sort(byName); d.removed.sort(byName); d.changed.sort(byName);
  return d;
}

export interface Policy {
  denyLicenses: string[];
  failOnDowngrade: boolean;
  failOnAdded: boolean;
}

export interface Violation { code: string; message: string }

export function evaluate(d: Diff, p: Policy): Violation[] {
  const out: Violation[] = [];
  const deny = new Set(p.denyLicenses.map((l) => l.toLowerCase()));
  for (const c of d.added) {
    const bad = c.licenses.filter((l) => deny.has(l.toLowerCase()));
    if (bad.length) out.push({ code: "DENIED_LICENSE", message: `new component ${c.name}@${c.version} uses ${bad.join(", ")}` });
  }
  for (const l of d.licenseChanges) {
    const bad = l.to.filter((x) => deny.has(x.toLowerCase()) && !l.from.includes(x));
    if (bad.length) out.push({ code: "LICENSE_CHANGED_TO_DENIED", message: `${l.name}@${l.version} changed license to ${bad.join(", ")}` });
  }
  if (p.failOnDowngrade) for (const c of d.changed) if (c.direction === "downgrade") out.push({ code: "DOWNGRADE", message: `${c.name} downgraded ${c.from} -> ${c.to}` });
  if (p.failOnAdded && d.added.length) out.push({ code: "NEW_COMPONENTS", message: `${d.added.length} new component(s) added: ${d.added.slice(0, 5).map((c) => c.name).join(", ")}${d.added.length > 5 ? ", ..." : ""}` });
  return out;
}
