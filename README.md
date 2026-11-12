# sbom-diff

Compare two **CycloneDX JSON SBOMs** and see what changed in your software supply chain between releases: new dependencies, removed ones, upgrades, **downgrades**, and license changes. Add policy flags and it becomes a CI gate. TypeScript, no runtime dependencies.

> Built with AI assistance (Claude) as a portfolio project. Review the code before relying on it.

## Usage

```bash
npm install && npm run build
node dist/src/cli.js before.cdx.json after.cdx.json
node dist/src/cli.js before.cdx.json after.cdx.json --deny-license AGPL-3.0-only --fail-on-downgrade
node dist/src/cli.js a.json b.json --json
```

```
+ mongodb-driver 5.0.0  [AGPL-3.0-only]
- left-pad 1.3.0
^ lodash 4.17.20 -> 4.17.21
v express 4.18.2 -> 4.17.1  (DOWNGRADE)

1 added, 1 removed, 2 changed, 0 license change(s), 0 unchanged
POLICY DENIED_LICENSE: new component mongodb-driver@5.0.0 uses AGPL-3.0-only
```

Exit codes: `0` ok, `1` policy violated, `2` invalid input.

## Policy flags

| Flag | Fails the build when |
|------|----------------------|
| `--deny-license ID` (repeatable, case-insensitive) | a new component, or an existing one that changed license, uses a denied license |
| `--fail-on-downgrade` | a dependency moved to an older version (a classic sign of a dependency confusion or rollback to a vulnerable release) |
| `--fail-on-added` | any new component appeared, useful for locked-down releases |

## How matching works

* Components are matched by **package URL without the version** (`pkg:npm/%40scope/pkg`), falling back to `group/name`. The same name in two ecosystems is two components (tested)
* A component present in several versions is paired sensibly instead of reporting noise
* Versions compare numerically (`1.10.0 > 1.9.9`) and pre-releases sort before releases
* License changes are only reported when the version is unchanged, so an upgrade that also relicenses shows as a change rather than hiding behind a license alert
* Nested components are flattened with a depth cap, and non-CycloneDX or malformed input is rejected with a clear error

Generate SBOMs with `cyclonedx-npm`, `syft`, `trivy sbom` or your build tool's CycloneDX plugin.

## Development

```bash
npm ci && npm test
```

MIT licensed.
