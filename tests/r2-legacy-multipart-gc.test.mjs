import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const env = {
  ...process.env,
  R2_ACCOUNT_ID: "test-account",
  R2_ACCESS_KEY_ID: "test-key",
  R2_SECRET_ACCESS_KEY: "test-secret",
  R2_BUCKET: "test-bucket",
  R2_RETRY_BASE_DELAY_SECONDS: "0",
};

test("scanner follows explicit key/upload markers past false IsTruncated and deduplicates IDs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "legacy-scan-"));
  try {
    const output = path.join(dir, "uploads.tsv");
    const cursor = path.join(dir, "cursor.json");
    const fake = path.join(dir, "fake-aws");
    await writeFile(fake, String.raw`#!/usr/bin/env bash
set -euo pipefail
args=" $* "
if [[ "$args" != *" --key-marker "* ]]; then
  printf '%s\n' '{"IsTruncated":false,"Uploads":[{"Key":"checkpoints/historical/versions/stale.sqlite","UploadId":"u1","Initiated":"2026-08-01T00:00:00Z"}]}'
elif [[ "$args" == *" --upload-id-marker u1 "* ]]; then
  printf '%s\n' '{"IsTruncated":false,"Uploads":[{"Key":"checkpoints/historical/versions/stale.sqlite","UploadId":"u2","Initiated":"2026-08-01T00:01:00Z"}]}'
else
  printf '%s\n' '{"IsTruncated":false,"Uploads":[]}'
fi
`, { mode: 0o755 });
    const { stdout } = await run("bash", ["-c", String.raw`
      set -euo pipefail
      aws() { "$FAKE_AWS" "$@"; }
      source scripts/r2-legacy-multipart-gc.sh
      scan_all_multipart_uploads "$OUTPUT" "$CURSOR"
    `], { env: { ...env, FAKE_AWS: fake, OUTPUT: output, CURSOR: cursor } });
    assert.equal(stdout.trim(), "3");
    assert.equal((await readFile(output, "utf8")).trim().split("\n").length, 2);
    assert.equal(JSON.parse(await readFile(cursor, "utf8")).page, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanner fails closed when an endpoint ignores the continuation cursor", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "legacy-repeat-"));
  try {
    const fake = path.join(dir, "fake-aws");
    await writeFile(fake, "#!/usr/bin/env bash\nprintf '%s\\n' '{\"IsTruncated\":false,\"Uploads\":[{\"Key\":\"stale\",\"UploadId\":\"u1\"}]}'\n", { mode: 0o755 });
    await assert.rejects(run("bash", ["-c", String.raw`
      set -euo pipefail
      aws() { "$FAKE_AWS" "$@"; }
      source scripts/r2-legacy-multipart-gc.sh
      scan_all_multipart_uploads "$OUTPUT" "$CURSOR"
    `], { env: { ...env, FAKE_AWS: fake, OUTPUT: path.join(dir, "out"), CURSOR: path.join(dir, "cursor") } }), error => {
      assert.equal(error.code, 47);
      assert.match(error.stderr, /no new UploadId/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
