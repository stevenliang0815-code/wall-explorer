import type { HistoricalObservation } from "./historical-data";

export const SNAPSHOT_FORMAT = "wall-explorer-historical-v1";
export const SNAPSHOT_SCHEMA_VERSION = 1;

export type SnapshotChunk = {
  index: number;
  path: string;
  rows: number;
  bytes: number;
  sha256: string;
  encoding: "gzip";
  contentType: "application/json";
};

export type HistoricalSnapshotManifest = {
  format: typeof SNAPSHOT_FORMAT;
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  snapshotVersion: string;
  generatedAt: string;
  cutoffDate: string;
  range: { start: string; end: string };
  rowCount: number;
  securityCount: number;
  markets: Record<"上市" | "上櫃", { rows: number; dates: number }>;
  sqlite: { path: string; bytes: number; sha256: string; encoding: "gzip" };
  chunks: SnapshotChunk[];
  validation: {
    status: "pass" | "blocked";
    openFailures: number;
    duplicates: number;
    survivorshipViolations: number;
    lookAheadViolations: number;
  };
  sources: string[];
};

export function validateSnapshotManifest(value: unknown): HistoricalSnapshotManifest {
  if (!value || typeof value !== "object") throw new Error("Snapshot manifest is not an object");
  const manifest = value as Partial<HistoricalSnapshotManifest>;
  if (manifest.format !== SNAPSHOT_FORMAT || manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("Snapshot format or schema version is unsupported");
  }
  if (!manifest.snapshotVersion || !/^\d{4}-\d{2}-\d{2}[-a-zA-Z0-9.]*$/.test(manifest.snapshotVersion)) {
    throw new Error("Snapshot version is invalid");
  }
  if (!manifest.cutoffDate || !/^\d{4}-\d{2}-\d{2}$/.test(manifest.cutoffDate)) throw new Error("Snapshot cutoff is invalid");
  if (!Number.isInteger(manifest.rowCount) || (manifest.rowCount ?? 0) <= 0) throw new Error("Snapshot row count is invalid");
  if (!Array.isArray(manifest.chunks) || !manifest.chunks.length) throw new Error("Snapshot has no import chunks");
  if (manifest.validation?.status !== "pass" || manifest.validation.openFailures !== 0 || manifest.validation.duplicates !== 0 || manifest.validation.survivorshipViolations !== 0 || manifest.validation.lookAheadViolations !== 0) {
    throw new Error("Snapshot validation gate did not pass");
  }
  for (const [index, chunk] of manifest.chunks.entries()) {
    if (chunk.index !== index || !chunk.path || !Number.isInteger(chunk.rows) || chunk.rows <= 0 || !/^[a-f0-9]{64}$/.test(chunk.sha256)) {
      throw new Error(`Snapshot chunk ${index} is invalid`);
    }
  }
  return manifest as HistoricalSnapshotManifest;
}

export function validateSnapshotRows(value: unknown, cutoffDate: string): HistoricalObservation[] {
  if (!Array.isArray(value)) throw new Error("Snapshot chunk is not a JSON array");
  return value.map((item, index) => {
    const row = item as Partial<HistoricalObservation>;
    if ((row.market !== "上市" && row.market !== "上櫃") || !row.code || !row.name || !row.tradingDate || row.tradingDate > cutoffDate) {
      throw new Error(`Snapshot row ${index} has invalid identity fields`);
    }
    if (row.sourceScope !== "full_market_daily" || !row.usableFrom || row.usableFrom.slice(0, 10) <= row.tradingDate) {
      throw new Error(`Snapshot row ${index} violates point-in-time rules`);
    }
    return row as HistoricalObservation;
  });
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", source as BufferSource);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function snapshotAssetUrl(manifestUrl: string, path: string) {
  const resolved = new URL(path, manifestUrl);
  if (resolved.protocol !== "https:" && resolved.hostname !== "localhost") throw new Error("Snapshot assets must use HTTPS");
  return resolved.toString();
}
