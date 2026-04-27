# Recipes are run inside `nix develop` so they pick up the dev shell tools.

default:
    @just --list

# Refresh sources.json against the latest stable openai/codex release.
update:
    deno run --allow-read --allow-write --allow-run --allow-env --allow-net scripts/update-sources.ts

# Run the full flake check (includes the smoke build).
check:
    nix flake check

# Smoke-build the codex package for the current system.
build:
    nix build .#codex

# Format flake.nix with nixfmt.
fmt:
    nixfmt flake.nix

# Run the Deno unit tests.
test:
    deno test scripts/
