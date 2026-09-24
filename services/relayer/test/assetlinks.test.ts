// services/relayer/test/assetlinks.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  ASSETLINKS_RELATION,
  DEFAULT_ASSETLINKS_PACKAGE,
  DEFAULT_ASSETLINKS_SHA256_FINGERPRINTS,
  assetlinksRouter,
  buildAssetLinks,
  normalizeFingerprint,
  parseFingerprintsEnv,
} from "../src/assetlinks.js";

const FP = DEFAULT_ASSETLINKS_SHA256_FINGERPRINTS[0];

test("normalizeFingerprint: accepts colon-separated, bare hex and lower case; emits canonical form", () => {
  assert.equal(normalizeFingerprint(FP), FP);
  assert.equal(normalizeFingerprint(FP.toLowerCase()), FP);
  assert.equal(normalizeFingerprint(FP.replace(/:/g, "")), FP);
  assert.equal(normalizeFingerprint(`  ${FP} `), FP);
});

test("normalizeFingerprint: rejects wrong length and non-hex", () => {
  assert.throws(() => normalizeFingerprint("FA:C6"), /invalid SHA-256 certificate fingerprint/);
  assert.throws(() => normalizeFingerprint("ZZ".repeat(32)), /invalid SHA-256 certificate fingerprint/);
});

test("parseFingerprintsEnv: empty/undefined -> debug-keystore default; comma list is normalised and de-duplicated", () => {
  assert.deepEqual(parseFingerprintsEnv(undefined), DEFAULT_ASSETLINKS_SHA256_FINGERPRINTS);
  assert.deepEqual(parseFingerprintsEnv(""), DEFAULT_ASSETLINKS_SHA256_FINGERPRINTS);
  const other = "AB".repeat(32);
  assert.deepEqual(parseFingerprintsEnv(`${FP.toLowerCase()}, ${other},${FP}`), [FP, other.match(/.{2}/g)!.join(":")]);
});

test("buildAssetLinks: one android_app statement with the handle_all_urls relation", () => {
  const stmts = buildAssetLinks(DEFAULT_ASSETLINKS_PACKAGE, [FP]);
  assert.deepEqual(stmts, [
    {
      relation: [ASSETLINKS_RELATION],
      target: { namespace: "android_app", package_name: "com.dexxer.app", sha256_cert_fingerprints: [FP] },
    },
  ]);
  assert.equal(ASSETLINKS_RELATION, "delegate_permission/common.handle_all_urls");
});

test("buildAssetLinks: rejects a bad package name or an empty fingerprint list", () => {
  assert.throws(() => buildAssetLinks("not a package", [FP]), /invalid Android package name/);
  assert.throws(() => buildAssetLinks(DEFAULT_ASSETLINKS_PACKAGE, []), /at least one certificate fingerprint/);
});

test("GET /.well-known/assetlinks.json: 200 application/json with the statement", async () => {
  const app = express();
  app.use(assetlinksRouter({ packageName: DEFAULT_ASSETLINKS_PACKAGE, fingerprints: [FP] }));
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/assetlinks.json`);
    assert.equal(res.status, 200);
    // EXACT match required by the MWA DAL verifier (`"application/json".equals(mimeType)`) — no charset suffix.
    assert.equal(res.headers.get("content-type"), "application/json");
    const body = (await res.json()) as unknown;
    assert.deepEqual(body, buildAssetLinks(DEFAULT_ASSETLINKS_PACKAGE, [FP]));
  } finally {
    server.close();
  }
});
