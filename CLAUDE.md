# CLAUDE.md

Guidance for working in this repository.

## Project intent

A small Nix flake that mirrors the upstream [OpenAI Codex CLI](https://github.com/openai/codex)
prebuilt binaries with daily auto-updates and Sigstore signature
verification on Linux. The goals are (a) staying close to upstream
releases and (b) keeping the supply-chain trust boundary minimal.

## Repository layout

```
flake.nix
flake.lock                 (committed)
sources.json               (machine-generated; do not hand-edit)
justfile
README.md
LICENSE                    (MIT, this repo)
LICENSE-CODEX              (Apache-2.0, redistributed upstream notice)
.gitignore
.github/
  workflows/
    ci.yaml
    update.yaml
  actions/setup-nix/action.yaml
scripts/
  update-sources.ts        (Deno; gh release lookup + tar member extract +
                            cosign verify-blob + in-memory SRI hash)
  update-sources_test.ts   (tag-regex + identity-template + sriHash tests)
```

## Common commands

The `justfile` recipes assume the dev-shell tools (`deno`, `gh`, `cosign`,
`just`, `nixfmt`) are already on `PATH`. Either enter the shell once with
`nix develop` and then invoke `just <recipe>`, or wrap each invocation with
`nix develop -c just <recipe>` (the pattern CI uses). The recipes themselves
do not re-enter `nix develop` for you.

| Command          | Purpose                                                        |
| ---------------- | -------------------------------------------------------------- |
| `just update`    | Refresh `sources.json` from the latest stable upstream release |
| `just check`     | `nix flake check` (build + checks for the current system)      |
| `just build`     | `nix build .#codex` (smoke build)                              |
| `just fmt`       | Format `flake.nix` with `nixfmt`                               |
| `just test`      | `deno test scripts/`                                           |

## Conventions

### Language

**All artifacts in this repository are written in English.** This applies
to source code, comments, documentation, README, CLAUDE.md, commit
messages, pull request descriptions, GitHub issues opened by the update
workflow, and workflow / step names.

### GitHub Actions pinning

Every `uses:` reference must be pinned to a full 40-character commit SHA,
with a trailing comment naming the corresponding tag for human review.
Never replace a SHA pin with a `@v*` tag.

```yaml
- uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
```

### Tag regex

Stable upstream releases match `^rust-v\d+\.\d+\.\d+$`. The same regex
appears twice — once in `scripts/update-sources.ts` (Deno) and once in
`.github/workflows/update.yaml` (bash, before `git commit`). Keep both
copies in sync. The shell side is defense-in-depth against a future
script bug accidentally relaxing the rule.

### Cosign identity pinning

The Sigstore certificate identity passed to `cosign verify-blob` is
pinned to the **exact upstream workflow path and release tag**:

```
^https://github\.com/openai/codex/\.github/workflows/rust-release\.yml@refs/tags/<tag>$
```

This rejects signatures from any other workflow file and prevents reuse
of a signature from a different release tag. The OIDC issuer is fixed to
`https://token.actions.githubusercontent.com`.

### Sigstore bundle target

Sigstore bundles published upstream sign the **bare binary** that
preceded tarball compression (the upstream `linux-code-sign` action runs
`cosign sign-blob` before `tar czf`). The update script therefore
extracts the binary from the tarball and passes that file — not the
tarball — to `cosign verify-blob`.

### `sources.json`

Machine-generated. Each platform entry maps an artifact name to an object
carrying `url`, `hash`, and `binary` (the file name inside the tarball,
e.g. `codex-x86_64-unknown-linux-musl`). The artifact name is both the
upstream asset prefix and the name the binary takes under `$out/bin`, so
`flake.nix` installs straight from these keys and needs no separate
lookup table. The artifact set lives in `ARTIFACTS` in
`scripts/update-sources.ts`. Do not hand-edit; use `just update`.

Note that `just update` short-circuits on a matching tag, so a change to
the artifact set does not backfill into an already-current `sources.json`.
Regenerating then requires an upstream tag bump.

### No Nix store cache in CI

`cache-nix-action` was removed and must not come back. Its cache tarball
carries both `/nix/var/nix/db` and `/nix/store`, and `tar` treats
per-entry hard-link failures as non-fatal, exiting non-zero only at the
very end. The database therefore restores completely while an arbitrary
subset of store paths does not, and every later `nix develop` dies with
`store path ... does not exist`. Because a failed restore is only a
warning, the job never falls back to a cache miss. The upstream trigger
is [cache-nix-action#170](https://github.com/nix-community/cache-nix-action/issues/170),
and `DeterminateSystems/nix-installer-action` is not in that action's
compatible-installer list to begin with
([#337](https://github.com/nix-community/cache-nix-action/issues/337)).
The same configuration kept a sibling repository's scheduled workflow
broken for 61 consecutive days. Caching bought little here anyway: the
derivation is `fetchurl` + copy with no compile step and the devShell is
fully binary-cached. If a store cache is ever reintroduced, do not reuse
the `nix-v1-` key prefix.

### Update failure notification

A failure opens an issue labelled `update-failed`, or rewrites the title
and body of the one already open — it never adds a comment, so the only
notification is the initial one. The title carries the consecutive
failure count (`(×N)`) so the severity is visible from the issue list. A
later successful run closes that issue, which is what re-arms the
notification: leaving one open would let the next outage land as a
silent in-place edit.

## Out of scope

- Building Codex from source (the upstream Cargo + Bazel workspace is
  large and slow; tracking pre-built binaries is the entire point).
- Windows.
- home-manager / nix-darwin modules.
- Sub-binaries shipped alongside `codex` (`codex-app-server`,
  `codex-responses-api-proxy`, etc.), with one exception:
  `codex-code-mode-host`. `codex` spawns it by looking next to its own
  executable, so it cannot be a separate package joined on `PATH` — it
  has to be installed into the same `$out/bin`, or Code Mode fails closed
  at runtime.
