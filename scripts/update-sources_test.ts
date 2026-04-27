import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { buildIdentityRegex, TAG_PATTERN } from "./update-sources.ts";

Deno.test("TAG_PATTERN accepts canonical stable tags", () => {
  assert(TAG_PATTERN.test("rust-v1.2.3"));
  assert(TAG_PATTERN.test("rust-v0.125.0"));
  assert(TAG_PATTERN.test("rust-v10.20.30"));
});

Deno.test("TAG_PATTERN rejects alpha / beta / rc suffixes", () => {
  assertFalse(TAG_PATTERN.test("rust-v1.2.3-alpha.1"));
  assertFalse(TAG_PATTERN.test("rust-v1.2.3-beta.2"));
  assertFalse(TAG_PATTERN.test("rust-v1.2.3-rc.1"));
});

Deno.test("TAG_PATTERN rejects bare semver without rust-v prefix", () => {
  assertFalse(TAG_PATTERN.test("v1.2.3"));
  assertFalse(TAG_PATTERN.test("1.2.3"));
});

Deno.test("TAG_PATTERN rejects malformed numeric components", () => {
  // Leading zeros are excluded so the upstream tag round-trips through
  // semver tooling without surprises.
  assertFalse(TAG_PATTERN.test("rust-v01.2.3"));
  // Two-component versions are not stable upstream releases.
  assertFalse(TAG_PATTERN.test("rust-v1.2"));
});

Deno.test("buildIdentityRegex pins workflow path and tag", () => {
  const tag = "rust-v0.125.0";
  const got = buildIdentityRegex(tag);
  assertEquals(
    got,
    "^https://github\\.com/openai/codex/\\.github/workflows/rust-release\\.yml@refs/tags/rust-v0.125.0$",
  );
});

Deno.test("buildIdentityRegex actually matches a representative SAN URI", () => {
  const tag = "rust-v0.125.0";
  const re = new RegExp(buildIdentityRegex(tag));
  // Representative SAN URI shape from a real upstream sigstore certificate.
  const validSan =
    "https://github.com/openai/codex/.github/workflows/rust-release.yml@refs/tags/rust-v0.125.0";
  assert(re.test(validSan));

  // A signature reused from a different tag must not satisfy the regex.
  const otherTagSan =
    "https://github.com/openai/codex/.github/workflows/rust-release.yml@refs/tags/rust-v0.124.0";
  assertFalse(re.test(otherTagSan));

  // A different workflow file under .github/workflows/ must not satisfy
  // the regex either.
  const otherWorkflowSan =
    "https://github.com/openai/codex/.github/workflows/release.yml@refs/tags/rust-v0.125.0";
  assertFalse(re.test(otherWorkflowSan));
});
