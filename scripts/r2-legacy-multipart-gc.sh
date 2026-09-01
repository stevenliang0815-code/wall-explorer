#!/usr/bin/env bash
set -euo pipefail

# Read-only classification is enabled first. GC mutation is deliberately added
# in a separate reviewed change after this scanner proves the live split.

# shellcheck source=scripts/r2-historical-common.sh
source scripts/r2-historical-common.sh

historical_checkpoint_prefix="${R2_HISTORICAL_CHECKPOINT_PREFIX:-checkpoints/historical/versions/}"
page_size="${R2_MULTIPART_PAGE_SIZE:-1000}"
max_pages="${R2_MULTIPART_MAX_PAGES:-100000}"

test "$page_size" -ge 1 && test "$page_size" -le 1000
test "$max_pages" -ge 1

decode_b64() {
  printf '%s' "$1" | base64 --decode
}

scan_all_multipart_uploads() {
  local output="$1" cursor_file="$2" page_dir page_file error_file rows_file meta_file
  local key_marker_b64="" upload_marker_b64="" key_marker="" upload_marker=""
  local page=0 page_rows new_rows next_key_b64 next_upload_b64
  local pair_hash key_b64 upload_b64 initiated_b64
  declare -A seen_uploads=()
  declare -A seen_cursors=()

  page_dir=$(mktemp -d)
  page_file="$page_dir/page.json"
  error_file="$page_dir/page.err"
  rows_file="$page_dir/rows.tsv"
  meta_file="$page_dir/meta.tsv"
  : > "$output"
  chmod 600 "$output"

  if [ -s "$cursor_file" ]; then
    read -r key_marker_b64 upload_marker_b64 page < <(python3 - "$cursor_file" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print(d.get("keyMarkerB64", "-"), d.get("uploadIdMarkerB64", "-"), int(d.get("page", 0)))
PY
)
    [ "$key_marker_b64" != - ] || key_marker_b64=""
    [ "$upload_marker_b64" != - ] || upload_marker_b64=""
  fi

  while [ "$page" -lt "$max_pages" ]; do
    local args=(s3api list-multipart-uploads --bucket "$bucket" --max-uploads "$page_size" --no-paginate --output json)
    if [ -n "$key_marker_b64" ]; then
      key_marker=$(decode_b64 "$key_marker_b64")
      args+=(--key-marker "$key_marker")
      if [ -n "$upload_marker_b64" ]; then
        upload_marker=$(decode_b64 "$upload_marker_b64")
        args+=(--upload-id-marker "$upload_marker")
      fi
    fi

    pair_hash=$(printf '%s\0%s' "$key_marker_b64" "$upload_marker_b64" | sha256sum | awk '{print $1}')
    if [ -n "${seen_cursors[$pair_hash]:-}" ]; then
      echo "::error::Multipart pagination cursor repeated; refusing an incomplete classification." >&2
      rm -r -- "$page_dir"
      return 47
    fi
    seen_cursors[$pair_hash]=1

    r2_retry_to_files "$page_file" "$error_file" "${args[@]}"
    python3 - "$page_file" "$rows_file" "$meta_file" <<'PY'
import base64,json,sys
source,rows_path,meta_path=sys.argv[1:]
d=json.load(open(source))
uploads=d.get("Uploads") or []
with open(rows_path,"w",encoding="ascii") as out:
    for u in uploads:
        values=[u.get("Key", ""),u.get("UploadId", ""),u.get("Initiated", "")]
        out.write("\t".join(base64.b64encode(v.encode()).decode() for v in values)+"\n")
def b64(value): return base64.b64encode((value or "").encode()).decode()
last=uploads[-1] if uploads else {}
next_key=d.get("NextKeyMarker") or last.get("Key", "")
next_upload=d.get("NextUploadIdMarker") or last.get("UploadId", "")
with open(meta_path,"w",encoding="ascii") as out:
    out.write("\t".join([
        str(len(uploads)),
        b64(next_key),b64(next_upload),
    ])+"\n")
PY
    read -r page_rows next_key_b64 next_upload_b64 < "$meta_file"
    new_rows=0
    while IFS=$'\t' read -r key_b64 upload_b64 initiated_b64; do
      [ -n "$upload_b64" ] || continue
      pair_hash=$(printf '%s\0%s' "$key_b64" "$upload_b64" | sha256sum | awk '{print $1}')
      if [ -z "${seen_uploads[$pair_hash]:-}" ]; then
        seen_uploads[$pair_hash]=1
        printf '%s\t%s\t%s\n' "$key_b64" "$upload_b64" "$initiated_b64" >> "$output"
        new_rows=$((new_rows + 1))
      fi
    done < "$rows_file"

    page=$((page + 1))
    python3 - "$cursor_file" "$next_key_b64" "$next_upload_b64" "$page" <<'PY'
import datetime,json,sys
path,key,upload,page=sys.argv[1:]
json.dump({
  "format":"wall-explorer-multipart-pagination-v1",
  "keyMarkerB64":key,
  "uploadIdMarkerB64":upload,
  "page":int(page),
  "updatedAt":datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z"),
},open(path,"w"),separators=(",", ":")); open(path,"a").write("\n")
PY

    if [ "$page_rows" -eq 0 ]; then
      rm -r -- "$page_dir"
      printf '%s\n' "$page"
      return 0
    fi
    if [ "$new_rows" -eq 0 ]; then
      echo "::error::Multipart pagination returned no new UploadId at a new cursor; refusing an incomplete classification." >&2
      rm -r -- "$page_dir"
      return 47
    fi

    # R2 has historically returned IsTruncated=false while another UploadId for
    # the same key was reachable by marker. Always perform a terminal marker
    # probe; an empty page is the only accepted end-of-scan signal.
    key_marker_b64="$next_key_b64"
    upload_marker_b64="$next_upload_b64"
    [ -n "$key_marker_b64" ] && [ -n "$upload_marker_b64" ] || {
      echo "::error::Multipart pagination page had rows but no safe continuation marker." >&2
      rm -r -- "$page_dir"
      return 47
    }
  done

  echo "::error::Multipart pagination exceeded ${max_pages} pages." >&2
  rm -r -- "$page_dir"
  return 47
}

download_optional_json() {
  local key="$1" output="$2"
  if object_exists "$key"; then
    download_object "$key" "$output"
  else
    printf '{}\n' > "$output"
  fi
}

classify_uploads() {
  local dir uploads cursor pages resolved latest_key state_file lease_file descriptor_file descriptor_key
  local report_file fingerprint_file current_pairs current_count current_bytes=0 key_b64 upload_b64
  dir=$(mktemp -d)
  uploads="$dir/uploads.tsv"
  cursor="$dir/cursor.json"
  state_file="$dir/state.json"
  lease_file="$dir/lease.json"
  descriptor_file="$dir/descriptor.json"
  current_pairs="$dir/current.tsv"
  report_file="${R2_MULTIPART_REPORT_FILE:-$dir/report.json}"
  fingerprint_file="${R2_MULTIPART_FINGERPRINT_FILE:-$dir/fingerprints.ndjson}"

  pages=$(scan_all_multipart_uploads "$uploads" "$cursor")
  resolved=$(bash scripts/r2-checkpoint-lifecycle.sh resolve)
  latest_key=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["objectKey"])' "$resolved")
  download_optional_json "$state_key" "$state_file"
  download_optional_json "$lease_key" "$lease_file"
  descriptor_key=$(python3 - "$state_file" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); print((d.get("upload") or {}).get("descriptorKey", ""))
PY
)
  if [ -n "$descriptor_key" ]; then download_optional_json "$descriptor_key" "$descriptor_file"; else printf '{}\n' > "$descriptor_file"; fi

  python3 - "$uploads" "$state_file" "$lease_file" "$descriptor_file" "$latest_key" "$historical_checkpoint_prefix" "$pages" "$report_file" "$fingerprint_file" "$current_pairs" <<'PY'
import base64,datetime,hashlib,json,sys
uploads_path,state_path,lease_path,descriptor_path,latest_key,prefix,pages,report_path,fingerprints_path,current_path=sys.argv[1:]
state=json.load(open(state_path)); lease=json.load(open(lease_path)); descriptor=json.load(open(descriptor_path))
now=int(datetime.datetime.now(datetime.timezone.utc).timestamp())
lease_active=lease.get("status","active")=="active" and int(lease.get("expiresEpoch",0))>now
state_upload=state.get("upload") or {}
descriptor_status=descriptor.get("status","")
active_descriptor=descriptor_status in {"uploading","abort-failed"}
legacy=[]; current=[]; keep=[]; unrelated=[]
raw=[]
def dec(value): return base64.b64decode(value).decode()
for line in open(uploads_path,encoding="ascii"):
    if not line.strip(): continue
    key64,upload64,initiated64=line.rstrip("\n").split("\t")
    key,upload_id,initiated=map(dec,(key64,upload64,initiated64))
    item={"key":key,"uploadIdSha256":hashlib.sha256(upload_id.encode()).hexdigest(),"initiated":initiated}
    exact_state=(state_upload.get("objectKey")==key and descriptor.get("objectKey")==key and descriptor.get("uploadId")==upload_id)
    if key==latest_key:
        item["classification"]="keep-latest-checkpoint"; keep.append(item)
    elif exact_state and active_descriptor and lease_active:
        item["classification"]="current-lifecycle"; current.append(item); keep.append(item)
    elif key.startswith(prefix):
        item["classification"]="legacy"; legacy.append(item)
    else:
        item["classification"]="keep-unrelated-prefix"; unrelated.append(item); keep.append(item)
    raw.append((key64,upload64,item))
seen=set()
with open(fingerprints_path,"w",encoding="utf-8") as out:
    for item in sorted(legacy+keep,key=lambda x:(x["key"],x["uploadIdSha256"])):
        token=(item["key"],item["uploadIdSha256"])
        if token in seen: continue
        seen.add(token); out.write(json.dumps(item,separators=(",", ":"))+"\n")
with open(current_path,"w",encoding="ascii") as out:
    current_tokens={(x["key"],x["uploadIdSha256"]) for x in current}
    for key64,upload64,item in raw:
        if (item["key"],item["uploadIdSha256"]) in current_tokens:
            out.write(key64+"\t"+upload64+"\n")
prior=int(descriptor.get("recoveryAbortCount",0)) if descriptor.get("objectKey","").startswith(prefix) else 0
report={
  "status":"read_only_classification_complete",
  "pagination":{"pages":int(pages),"complete":True,"deduplicatedUploads":len(seen)},
  "latestCheckpoint":{"objectKey":latest_key},
  "leaseActive":lease_active,
  "currentLifecycle":{"unfinishedUploads":len(current),"unfinishedBytes":None},
  "legacy":{"currentlyListedUploads":len(legacy),"verifiedPriorAborts":prior,"knownUploads":prior+len(legacy)},
  "keep":{"uploads":len(keep),"latestCheckpointUploads":sum(x["classification"]=="keep-latest-checkpoint" for x in keep),"unrelatedUploads":len(unrelated)},
}
json.dump(report,open(report_path,"w"),separators=(",", ":")); open(report_path,"a").write("\n")
PY

  current_count=$(wc -l < "$current_pairs" | tr -d ' ')
  while IFS=$'\t' read -r key_b64 upload_b64; do
    [ -n "$upload_b64" ] || continue
    local object_key upload_id parts_file part_bytes
    object_key=$(decode_b64 "$key_b64")
    upload_id=$(decode_b64 "$upload_b64")
    parts_file="$dir/current-parts-$(printf '%s' "$upload_b64" | sha256sum | cut -c1-12).json"
    r2_retry_to_files "$parts_file" "$dir/current-parts.err" s3api list-parts --bucket "$bucket" --key "$object_key" --upload-id "$upload_id" --output json
    part_bytes=$(python3 -c 'import json,sys; print(sum(int(p.get("Size",0)) for p in json.load(open(sys.argv[1])).get("Parts",[])))' "$parts_file")
    current_bytes=$((current_bytes + part_bytes))
  done < "$current_pairs"

  python3 - "$report_file" "$current_bytes" <<'PY'
import json,sys
path,current_bytes=sys.argv[1:]
d=json.load(open(path)); d["currentLifecycle"]["unfinishedBytes"]=int(current_bytes)
json.dump(d,open(path,"w"),separators=(",", ":")); open(path,"a").write("\n")
PY
  python3 - "$report_file" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print("## Historical multipart classification")
print()
print(f"- Pagination complete: **{str(d['pagination']['complete']).lower()}** ({d['pagination']['pages']} page(s))")
print(f"- Deduplicated uploads currently listed: **{d['pagination']['deduplicatedUploads']:,}**")
print(f"- Current lifecycle unfinished: **{d['currentLifecycle']['unfinishedUploads']:,} upload(s), {d['currentLifecycle']['unfinishedBytes']:,} bytes**")
print(f"- Legacy currently listed: **{d['legacy']['currentlyListedUploads']:,}**")
print(f"- Legacy uploads already explicitly aborted: **{d['legacy']['verifiedPriorAborts']:,}**")
print(f"- Known legacy total: **{d['legacy']['knownUploads']:,}**")
print(f"- Keep-list uploads: **{d['keep']['uploads']:,}**")
PY
  [ "$current_count" -ge 0 ]
  rm -r -- "$dir"
}

main() {
  case "${1:-classify}" in
    classify) classify_uploads ;;
    scan) scan_all_multipart_uploads "${2:?output required}" "${3:?cursor required}" ;;
    *) echo "Usage: $0 {classify|scan OUTPUT CURSOR}" >&2; exit 2 ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi

