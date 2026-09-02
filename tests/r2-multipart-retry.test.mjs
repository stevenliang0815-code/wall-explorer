import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const env = {
  ...process.env,
  R2_ACCOUNT_ID: "test",
  R2_BUCKET: "test",
  R2_ACCESS_KEY_ID: "test",
  R2_SECRET_ACCESS_KEY: "test",
  R2_TRANSIENT_MAX_ATTEMPTS: "8",
  R2_RETRY_BASE_DELAY_SECONDS: "0",
};

test("R2 retry repeats the same transient UploadPart through success", async () => {
  const { stdout, stderr } = await execFile("bash", ["-c", String.raw`
    set -euo pipefail
    attempts=0
    aws() {
      attempts=$((attempts + 1))
      if [ "$attempts" -lt 4 ]; then
        echo "An error occurred (504) when calling the UploadPart operation: Gateway Timeout" >&2
        return 255
      fi
      printf '{"ETag":"same-part"}\n'
    }
    source scripts/r2-historical-common.sh
    r2_retry_to_files "$TMPDIR/out" "$TMPDIR/err" s3api upload-part --part-number 6
    printf 'attempts=%s output=%s\n' "$attempts" "$(cat "$TMPDIR/out")"
  `], { env: { ...env, TMPDIR: os.tmpdir() } });
  assert.match(stdout, /attempts=4 output=\{"ETag":"same-part"\}/);
  assert.match(stderr, /attempt 2\/8/);
  assert.match(stderr, /attempt 4\/8/);
});

test("R2 retry stops immediately for credential and other non-transient failures", async () => {
  await assert.rejects(execFile("bash", ["-c", String.raw`
    set -euo pipefail
    attempts=0
    aws() { attempts=$((attempts + 1)); echo "InvalidAccessKeyId: credential rejected" >&2; return 255; }
    source scripts/r2-historical-common.sh
    trap 'printf "attempts=%s\n" "$attempts"' EXIT
    r2_retry_to_files "$TMPDIR/out" "$TMPDIR/err" s3api upload-part --part-number 1
  `], { env: { ...env, TMPDIR: os.tmpdir() } }), (error) => {
    assert.match(error.stdout, /attempts=1/);
    assert.match(error.stderr, /InvalidAccessKeyId/);
    return true;
  });
});

test("exact multipart abort retries transient 5xx and verifies the upload disappeared", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "multipart-abort-"));
  try {
    const { stdout, stderr } = await execFile("bash", ["-c", String.raw`
      set -euo pipefail
      printf present > "$STATE"
      printf 0 > "$ATTEMPTS"
      aws() {
        case " $* " in
          *" list-multipart-uploads "*)
            if [ -f "$STATE" ]; then printf '{"Uploads":[{"Key":"immutable.sqlite","UploadId":"upload-123"}]}\n'; else printf '{"Uploads":[]}\n'; fi
            ;;
          *" abort-multipart-upload "*)
            n=$(( $(cat "$ATTEMPTS") + 1 )); printf '%s' "$n" > "$ATTEMPTS"
            if [ "$n" -lt 3 ]; then echo 'HTTP 503 ServiceUnavailable' >&2; return 255; fi
            rm -f "$STATE"; printf '{}\n'
            ;;
          *) echo "unexpected aws command: $*" >&2; return 2 ;;
        esac
      }
      source scripts/r2-historical-common.sh
      abort_multipart_upload_exact immutable.sqlite upload-123
      printf 'abort-attempts=%s remaining=%s\n' "$(cat "$ATTEMPTS")" "$([ -f "$STATE" ] && echo yes || echo no)"
    `], { env: { ...env, STATE: path.join(dir, "state"), ATTEMPTS: path.join(dir, "attempts") } });
    assert.match(stdout, /abort-attempts=3 remaining=no/);
    assert.match(stderr, /attempt 3\/8/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("multipart durable state includes upload ID and per-part ETag/bytes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "multipart-state-"));
  try {
    const parts = path.join(dir, "parts.ndjson");
    const state = path.join(dir, "state.json");
    await execFile("bash", ["-c", String.raw`
      set -euo pipefail
      source scripts/r2-historical-common.sh
      printf '%s\n' '{"PartNumber":1,"ETag":"etag-1","Size":256}' '{"PartNumber":2,"ETag":"etag-2","Size":128}' > "$PARTS"
      write_multipart_state_file "$STATE" descriptor.json immutable.sqlite upload-123 384 2 "$PARTS" uploading abc123
    `], { env: { ...env, PARTS: parts, STATE: state } });
    const document = JSON.parse(await readFile(state, "utf8"));
    assert.equal(document.uploadId, "upload-123");
    assert.equal(document.format, "wall-explorer-multipart-v3");
    assert.ok(document.createdAt);
    assert.deepEqual(document.sourceChecksum, { algorithm: "sha256", value: "abc123" });
    assert.equal(document.completedParts, 2);
    assert.equal(document.completedBytes, 384);
    assert.deepEqual(document.parts, [
      { partNumber: 1, etag: "etag-1", bytes: 256 },
      { partNumber: 2, etag: "etag-2", bytes: 128 },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("transient classifier covers required HTTP statuses and connection failures", async () => {
  const { stdout } = await execFile("bash", ["-c", String.raw`
    set -euo pipefail
    source scripts/r2-historical-common.sh
    for message in 'HTTP 408' 'HTTP 429' 'HTTP 500' 'HTTP 502' 'HTTP 503' 'HTTP 504' 'connection reset by peer' 'request timeout'; do
      printf '%s\n' "$message" > "$TMPDIR/error"
      is_transient_r2_error "$TMPDIR/error"
      printf 'ok\n'
    done
  `], { env: { ...env, TMPDIR: os.tmpdir() } });
  assert.equal(stdout.trim().split("\n").length, 8);
});

test("Backfill recovery dispatch classifies GitHub network failures as transient", async () => {
  const { stdout } = await execFile("bash", ["-c", String.raw`
    set -euo pipefail
    source scripts/r2-backfill38-recovery.sh
    for message in 'i/o timeout' 'connection reset by peer' 'HTTP 429' 'HTTP 502' 'HTTP 503' 'HTTP 504' 'TLS handshake timeout'; do
      printf '%s\n' "$message" > "$TMPDIR/github-error"
      github_dispatch_error_is_transient "$TMPDIR/github-error"
      printf 'ok\n'
    done
    printf '%s\n' 'HTTP 403 Resource not accessible by integration' > "$TMPDIR/github-error"
    if github_dispatch_error_is_transient "$TMPDIR/github-error"; then exit 9; fi
  `], { env: { ...env, TMPDIR: os.tmpdir() } });
  assert.equal(stdout.trim().split("\n").length, 7);
});

test("Backfill recovery keeps the durable pause and defers after transient dispatch exhaustion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "github-dispatch-"));
  try {
    const { stdout, stderr } = await execFile("bash", ["-c", String.raw`
      set -euo pipefail
      source scripts/r2-backfill38-recovery.sh
      mkdir -p "$RECOVERY_DIR"
      recovery_dir="$RECOVERY_DIR"
      github_dispatch_max_attempts=3
      github_dispatch_max_delay_seconds=0
      attempts=0
      assert_paused_pointer() { :; }
      assert_lease_inactive() { :; }
      object_exists() { :; }
      sleep() { :; }
      gh() { attempts=$((attempts + 1)); echo 'dial tcp: i/o timeout' >&2; return 1; }
      dispatch_next_recovery_batch
      printf 'attempts=%s\n' "$attempts"
    `], { env: { ...env, RECOVERY_DIR: path.join(dir, "work"), GITHUB_REPOSITORY: "owner/repo", GITHUB_STEP_SUMMARY: path.join(dir, "summary") } });
    assert.match(stdout, /attempts=3/);
    assert.match(stderr, /hourly scheduled resumer will retry automatically/);
    assert.match(await readFile(path.join(dir, "summary"), "utf8"), /durable pause and 99\.69% pointer remain intact/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Backfill recovery hard-stops on a non-transient GitHub dispatch error", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "github-dispatch-hard-"));
  try {
    await assert.rejects(execFile("bash", ["-c", String.raw`
      set -euo pipefail
      source scripts/r2-backfill38-recovery.sh
      mkdir -p "$RECOVERY_DIR"
      recovery_dir="$RECOVERY_DIR"
      assert_paused_pointer() { :; }
      assert_lease_inactive() { :; }
      object_exists() { :; }
      gh() { echo 'HTTP 403 Resource not accessible by integration' >&2; return 1; }
      dispatch_next_recovery_batch
    `], { env: { ...env, RECOVERY_DIR: path.join(dir, "work"), GITHUB_REPOSITORY: "owner/repo" } }), (error) => {
      assert.equal(error.code, 47);
      assert.match(error.stderr, /non-transient error/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
