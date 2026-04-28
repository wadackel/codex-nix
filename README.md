# codex-nix

[![CI](https://github.com/wadackel/codex-nix/actions/workflows/ci.yaml/badge.svg)](https://github.com/wadackel/codex-nix/actions/workflows/ci.yaml)

A Nix flake that packages the [OpenAI Codex CLI](https://github.com/openai/codex)
as a prebuilt binary, with daily auto-updates and Sigstore signature
verification on Linux.

## Why this flake

- Track upstream releases more closely than the version currently in nixpkgs.
- Keep the supply-chain trust boundary minimal by self-hosting the packaging
  rather than depending on a community flake.
- Verify Linux musl artifacts against their Sigstore bundles at update time so
  the SRI hashes that ship in `sources.json` cover signed binaries only.

## Supported systems

- `aarch64-darwin`
- `x86_64-darwin`
- `aarch64-linux` (musl)
- `x86_64-linux` (musl)

Windows is intentionally out of scope.

## Install

### Run ad-hoc

```sh
nix run github:wadackel/codex-nix -- --version
```

### Use as a flake input

```nix
{
  inputs.codex-nix.url = "github:wadackel/codex-nix";
  inputs.codex-nix.inputs.nixpkgs.follows = "nixpkgs";

  outputs = { self, nixpkgs, codex-nix, ... }: {
    # As a package
    packages.x86_64-linux.codex = codex-nix.packages.x86_64-linux.codex;

    # As an overlay
    nixpkgs.overlays = [ codex-nix.overlays.default ];
  };
}
```

The package places the upstream binary at `$out/bin/codex` and wraps it so
that [`ripgrep`](https://github.com/BurntSushi/ripgrep) is on `PATH` at
runtime — matching what `codex` expects to spawn.

## Configuration

Codex stores its configuration and logs under `$CODEX_HOME` (defaults to
`~/.codex`). The directory is created on first run; override `CODEX_HOME`
when you want a different location, for example when running from a
read-only home or inside a sandbox.

## How auto-updates work

A scheduled GitHub Actions workflow runs daily and:

1. Calls `gh api repos/openai/codex/releases/latest` (which already filters
   out prereleases).
2. Validates the tag against `^rust-v\d+\.\d+\.\d+$`.
3. For each supported platform, downloads the release tarball and — on
   Linux musl only — also downloads the matching Sigstore bundle, extracts
   the bare binary from the tarball, and runs `cosign verify-blob` against
   it. The cosign certificate identity is pinned to the exact upstream
   workflow path **and** the release tag, so a signature from a different
   workflow or a different tag will not verify.
4. Computes the SRI hash directly from the same in-memory tarball bytes
   that were Sigstore-verified (or, on Darwin, the bytes held in memory
   when the tarball was downloaded), then writes a new `sources.json`
   atomically. The hash is therefore guaranteed to cover exactly the
   bytes that were verified — there is no second network fetch that
   could drift.
5. Re-validates the tag in a shell guard before committing and pushing.

If anything fails, the workflow opens an issue tagged `update-failed` and
leaves the repository untouched.

This is a "Trust on First Update" model: once a tarball's hash is recorded
in `sources.json`, every subsequent build pins to that hash. The signature
check happens at update time, not at build time, which keeps the build
closure small and avoids putting `cosign` into the runtime dependency
graph.

Darwin artifacts do not ship Sigstore bundles upstream (Apple notarization
is used instead), so verification on Darwin is the SRI hash alone.

## License

This repository is licensed under the MIT License (see `LICENSE`).

The Codex CLI binaries redistributed via this flake are produced by OpenAI
under the Apache License 2.0; the upstream notice is preserved verbatim in
`LICENSE-CODEX`.
