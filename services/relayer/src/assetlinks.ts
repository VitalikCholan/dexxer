// services/relayer/src/assetlinks.ts
//
// GET /.well-known/assetlinks.json — Digital Asset Links statement that lets
// MWA wallets verify the Dexxer Android app's identity.
//
// Why here (24.09.2026, live Phantom smoke): Phantom refuses `reauthorize`
// for a dApp whose `identity.uri` has no verifiable Digital Asset Link
// (`mwaIdentityVerified !== true`), so every signing session cost the user
// an extra "authorize" prompt (`app/src/lib/mwaAuth.ts`'s fresh-authorize
// fallback). Per MWA spec §"Identity verification on Android", the wallet
// fetches `https://<identity.uri host>/.well-known/assetlinks.json` and
// checks that the CALLING package (from Android's binder, not from the
// request) is signed with a certificate listed in an `android_app` target
// with relation `delegate_permission/common.handle_all_urls`
// (solana-mobile/digital-asset-links-android `AndroidAppPackageVerifier`:
// https scheme required). The relayer already has a public HTTPS domain the
// app knows (`RELAYER_URL`), so it serves the statement; the app's
// `identity.uri` points at this host (`EXPO_PUBLIC_IDENTITY_URI`).
//
// Privacy: this endpoint is static public metadata about the APK
// (package name + signing-cert fingerprints). It reads no chain state and
// touches no key — consistent with the "servers read only public data" rule.
//
// Defaults are the dev-client build: `com.dexxer.app` signed with the
// Android debug keystore (`app/android/app/debug.keystore`,
// `keytool -list -v -alias androiddebugkey -storepass android`). A release
// build MUST set `ASSETLINKS_SHA256_FINGERPRINTS` to its own upload/signing
// certificate (comma-separated to list several).
import express from "express";
import type { Router } from "express";

export const DEFAULT_ASSETLINKS_PACKAGE = "com.dexxer.app";
/** Android debug keystore certificate (`app/android/app/debug.keystore`, alias `androiddebugkey`). */
export const DEFAULT_ASSETLINKS_SHA256_FINGERPRINTS = [
  "FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C",
];
export const ASSETLINKS_RELATION = "delegate_permission/common.handle_all_urls";

const FINGERPRINT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/**
 * Normalises one SHA-256 certificate fingerprint to the canonical
 * upper-case colon-separated form the Digital Asset Links grammar expects.
 * Accepts `aa:bb:..`, `aabb..` (64 hex chars) and mixed case; throws on
 * anything else so a typo in env fails the boot, not the wallet's check.
 */
export function normalizeFingerprint(raw: string): string {
  const hex = raw.trim().replace(/:/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) {
    throw new Error(`assetlinks: invalid SHA-256 certificate fingerprint ${JSON.stringify(raw)} (need 32 bytes as hex, optionally colon-separated)`);
  }
  const out = hex.match(/.{2}/g)!.join(":");
  if (!FINGERPRINT_RE.test(out)) throw new Error(`assetlinks: fingerprint normalisation failed for ${JSON.stringify(raw)}`);
  return out;
}

/** Parses the comma-separated `ASSETLINKS_SHA256_FINGERPRINTS` env value; empty/undefined -> defaults. */
export function parseFingerprintsEnv(value: string | undefined): string[] {
  const parts = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const list = parts.length > 0 ? parts : DEFAULT_ASSETLINKS_SHA256_FINGERPRINTS;
  return [...new Set(list.map(normalizeFingerprint))];
}

export interface AssetLinksStatement {
  relation: string[];
  target: {
    namespace: "android_app";
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
}

/** Pure builder — exercised directly by test/assetlinks.test.ts. */
export function buildAssetLinks(packageName: string, fingerprints: string[]): AssetLinksStatement[] {
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) {
    throw new Error(`assetlinks: invalid Android package name ${JSON.stringify(packageName)}`);
  }
  if (fingerprints.length === 0) throw new Error("assetlinks: at least one certificate fingerprint is required");
  return [
    {
      relation: [ASSETLINKS_RELATION],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: fingerprints.map(normalizeFingerprint),
      },
    },
  ];
}

export function assetlinksRouter(opts: { packageName: string; fingerprints: string[] }): Router {
  const router = express.Router();
  const body = JSON.stringify(buildAssetLinks(opts.packageName, opts.fingerprints));
  router.get("/.well-known/assetlinks.json", (_req, res) => {
    // `AndroidAppPackageVerifier`/`URISourceVerifier.loadDocument` compares the
    // MIME type with `"application/json".equals(getContentType())` — an EXACT
    // string match, so Express's `res.send` (which appends `; charset=utf-8`)
    // would fail verification (measured on fakewallet 24.09: "Package
    // verification failed" with the correct cert). Set the header verbatim and
    // write the body with `res.end`. Also: no redirects (the verifier does not
    // follow them), 1 s connect/read timeout on the wallet side, ≤ 50 KiB body.
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).end(body);
  });
  return router;
}
