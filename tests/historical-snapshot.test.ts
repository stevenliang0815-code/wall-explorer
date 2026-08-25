import assert from "node:assert/strict";
import test from "node:test";
import { SNAPSHOT_FORMAT, SNAPSHOT_SCHEMA_VERSION, validateSnapshotManifest, validateSnapshotRows } from "../lib/historical-snapshot.ts";

const rows = [{ market: "上市", code: "1234", name: "歷史下市樣本", tradingDate: "2020-01-02", securityType: "ordinary_equity_candidate", universeStatus: "traded_or_quoted", open: 10, high: 11, low: 9, close: 10, change: 1, volume: 1000, tradeValue: 10000, source: "https://official.example/day", sourceScope: "full_market_daily", usableFrom: "2020-01-03T00:00:00+08:00" }];

test("snapshot manifest must pass all hard validation gates", () => {
  const manifest = validateSnapshotManifest({
    format: SNAPSHOT_FORMAT, schemaVersion: SNAPSHOT_SCHEMA_VERSION, snapshotVersion: "2026-08-20-v1",
    generatedAt: "2026-08-20T00:00:00Z", cutoffDate: "2026-08-20", range: { start: "2010-01-04", end: "2026-08-20" },
    rowCount: 2, securityCount: 2, markets: { 上市: { rows: 1, dates: 1 }, 上櫃: { rows: 1, dates: 1 } },
    sqlite: { path: "historical.sqlite.gz", bytes: 10, sha256: "a".repeat(64), encoding: "gzip" },
    chunks: [{ index: 0, path: "chunks/0.json.gz", rows: 2, bytes: 10, sha256: "b".repeat(64), encoding: "gzip", contentType: "application/json" }],
    validation: { status: "pass", openFailures: 0, duplicates: 0, survivorshipViolations: 0, lookAheadViolations: 0 }, sources: ["https://official.example"],
  });
  assert.equal(manifest.snapshotVersion, "2026-08-20-v1");
  assert.throws(() => validateSnapshotManifest({ ...manifest, validation: { ...manifest.validation, openFailures: 1 } }), /validation gate/);
  assert.throws(() => validateSnapshotManifest({ ...manifest, markets: { ...manifest.markets, 上櫃: { rows: 0, dates: 0 } } }), /market coverage/);
});

test("snapshot rows retain delisted securities and block look-ahead data", () => {
  assert.equal(validateSnapshotRows(rows, "2026-08-20")[0].name, "歷史下市樣本");
  assert.throws(() => validateSnapshotRows([{ ...rows[0], usableFrom: "2020-01-02T16:30:00+08:00" }], "2026-08-20"), /point-in-time/);
});
