#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

// Refresh sources.json against the latest openai/codex stable release.
//
// stdout: "unchanged" when sources.json already tracks the latest tag,
//         "changed"   when sources.json was rewritten.
// exit 0: either of the above.
// exit 1: upstream fetch failure, asset lookup failure, sigstore verification
//         failure, or prefetch failure.

const UPSTREAM_OWNER = "openai";
const UPSTREAM_REPO = "codex";

// Stable releases only. Alpha/beta tags are filtered out by the upstream
// "prerelease" flag (gh api releases/latest skips them); this regex is
// defense-in-depth and the same shape is re-checked in update.yaml's
// commit guard. Leading zeros are rejected so the tag round-trips
// through semver tooling without surprises.
export const TAG_PATTERN = /^rust-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Pinned to the upstream workflow path AND the release tag. A signature
// produced by any other workflow file or any other tag will not verify.
export function buildIdentityRegex(tag: string): string {
  return `^https://github\\.com/openai/codex/\\.github/workflows/rust-release\\.yml@refs/tags/${tag}$`;
}

const COSIGN_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

type PlatformSpec = {
  // Rust target triple as it appears in upstream release asset names.
  target: string;
  // Whether upstream publishes a Sigstore bundle for this platform.
  sigstore: boolean;
};

const PLATFORMS: Record<string, PlatformSpec> = {
  "aarch64-darwin": { target: "aarch64-apple-darwin", sigstore: false },
  "x86_64-darwin": { target: "x86_64-apple-darwin", sigstore: false },
  "aarch64-linux": { target: "aarch64-unknown-linux-musl", sigstore: true },
  "x86_64-linux": { target: "x86_64-unknown-linux-musl", sigstore: true },
};

type PlatformEntry = {
  url: string;
  hash: string;
  binary: string;
};

type Sources = {
  version: string;
  tag: string;
  platforms: Record<string, PlatformEntry>;
};

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type Release = {
  tag_name: string;
  assets: ReleaseAsset[];
};

const scriptDir = new URL(".", import.meta.url).pathname;
const sourcesPath = `${scriptDir}../sources.json`;

async function runCmd(
  bin: string,
  args: string[],
  opts: { stdin?: Uint8Array } = {},
): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }> {
  const cmd = new Deno.Command(bin, {
    args,
    stdout: "piped",
    stderr: "piped",
    stdin: opts.stdin === undefined ? "null" : "piped",
  });
  const child = cmd.spawn();
  if (opts.stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(opts.stdin);
    await writer.close();
  }
  const { code, stdout, stderr } = await child.output();
  return { code, stdout, stderr };
}

async function fetchLatestRelease(): Promise<Release> {
  const { code, stdout, stderr } = await runCmd("gh", [
    "api",
    `repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/releases/latest`,
  ]);
  if (code !== 0) {
    throw new Error(`gh api failed (exit ${code}): ${new TextDecoder().decode(stderr)}`);
  }
  return JSON.parse(new TextDecoder().decode(stdout)) as Release;
}

async function downloadToBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`download failed for ${url}: HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

// Compute the SRI hash directly from already-downloaded bytes so that the
// hash recorded in sources.json covers exactly the bytes we sigstore-verified
// (or, on Darwin, exactly the bytes we held in memory at decision time).
// Refetching the URL via `nix store prefetch-file` would open a TOCTOU window
// where an upstream asset swap between the two fetches could pin bytes that
// were never verified.
export async function sriHash(bytes: Uint8Array): Promise<string> {
  // crypto.subtle.digest's typings reject ArrayBufferLike-backed Uint8Array,
  // so copy the bytes into a fresh ArrayBuffer first.
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  let binary = "";
  const view = new Uint8Array(digest);
  for (let i = 0; i < view.byteLength; i += 1) {
    binary += String.fromCharCode(view[i]);
  }
  return `sha256-${btoa(binary)}`;
}

async function extractBareBinary(
  tarballPath: string,
  binaryName: string,
): Promise<Uint8Array> {
  // -O streams a single member to stdout; -x extracts; -z auto-detects gzip.
  // The tarball is flat (no nested directory), so the member name equals
  // the binary name.
  const { code, stdout, stderr } = await runCmd("tar", [
    "-xzOf",
    tarballPath,
    binaryName,
  ]);
  if (code !== 0) {
    throw new Error(
      `tar extraction failed for ${binaryName} (exit ${code}): ${new TextDecoder().decode(stderr)}`,
    );
  }
  if (stdout.byteLength === 0) {
    throw new Error(`tar produced empty output for ${binaryName}`);
  }
  return stdout;
}

async function verifySigstore(
  tag: string,
  binaryPath: string,
  bundlePath: string,
): Promise<void> {
  const { code, stdout, stderr } = await runCmd("cosign", [
    "verify-blob",
    "--bundle",
    bundlePath,
    "--certificate-identity-regexp",
    buildIdentityRegex(tag),
    "--certificate-oidc-issuer",
    COSIGN_OIDC_ISSUER,
    binaryPath,
  ]);
  if (code !== 0) {
    throw new Error(
      `cosign verify-blob failed for ${binaryPath} (exit ${code}):\n` +
        `  stdout: ${new TextDecoder().decode(stdout)}\n` +
        `  stderr: ${new TextDecoder().decode(stderr)}`,
    );
  }
}

async function readCurrent(): Promise<Sources | null> {
  try {
    const raw = await Deno.readTextFile(sourcesPath);
    return JSON.parse(raw) as Sources;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

async function writeAtomic(next: Sources): Promise<void> {
  const tmp = `${sourcesPath}.tmp.${crypto.randomUUID()}`;
  await Deno.writeTextFile(tmp, JSON.stringify(next, null, 2) + "\n");
  await Deno.rename(tmp, sourcesPath);
}

function versionFromTag(tag: string): string {
  // tag = "rust-vX.Y.Z" → "X.Y.Z"
  return tag.replace(/^rust-v/, "");
}

function findAsset(release: Release, name: string): ReleaseAsset {
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) {
    throw new Error(`Asset not found in release ${release.tag_name}: ${name}`);
  }
  return asset;
}

async function processPlatform(
  release: Release,
  system: string,
  spec: PlatformSpec,
  workDir: string,
): Promise<PlatformEntry> {
  const tarballName = `codex-${spec.target}.tar.gz`;
  const tarballAsset = findAsset(release, tarballName);
  const binary = `codex-${spec.target}`;

  // Always download the tarball into memory once; everything below — sigstore
  // verification on Linux musl, and the SRI hash recorded in sources.json —
  // is derived from THESE bytes. Refetching the URL elsewhere would reopen a
  // TOCTOU window where an upstream asset swap between fetches could let
  // sources.json pin bytes that were never sigstore-verified.
  const tarballBytes = await downloadToBytes(tarballAsset.browser_download_url);
  const tarballPath = `${workDir}/${tarballName}`;
  await Deno.writeFile(tarballPath, tarballBytes);

  if (spec.sigstore) {
    const bundleName = `${binary}.sigstore`;
    const bundleAsset = findAsset(release, bundleName);
    const bundleBytes = await downloadToBytes(bundleAsset.browser_download_url);
    const bundlePath = `${workDir}/${bundleName}`;
    const bareBinaryPath = `${workDir}/${binary}`;
    await Deno.writeFile(bundlePath, bundleBytes);

    const bareBinaryBytes = await extractBareBinary(tarballPath, binary);
    await Deno.writeFile(bareBinaryPath, bareBinaryBytes);

    await verifySigstore(release.tag_name, bareBinaryPath, bundlePath);
    console.error(`[update-sources] sigstore verified for ${system} (${binary})`);
  } else {
    console.error(`[update-sources] sigstore skipped for ${system} (no upstream bundle)`);
  }

  const hash = await sriHash(tarballBytes);
  return { url: tarballAsset.browser_download_url, hash, binary };
}

async function main(): Promise<void> {
  const release = await fetchLatestRelease();
  if (!TAG_PATTERN.test(release.tag_name)) {
    throw new Error(
      `Refusing tag with unexpected shape: ${JSON.stringify(release.tag_name)}`,
    );
  }
  console.error(`[update-sources] upstream latest tag: ${release.tag_name}`);

  const current = await readCurrent();
  if (current && current.tag === release.tag_name) {
    console.error("[update-sources] decision: unchanged (tags match)");
    console.log("unchanged");
    return;
  }

  const workDir = await Deno.makeTempDir({ prefix: "codex-nix-update-" });
  try {
    const platforms: Record<string, PlatformEntry> = {};
    for (const [system, spec] of Object.entries(PLATFORMS)) {
      platforms[system] = await processPlatform(release, system, spec, workDir);
    }

    const next: Sources = {
      version: versionFromTag(release.tag_name),
      tag: release.tag_name,
      platforms,
    };
    await writeAtomic(next);
    console.error(
      `[update-sources] decision: changed (${current?.tag ?? "(none)"} -> ${release.tag_name})`,
    );
    console.log("changed");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  });
}
