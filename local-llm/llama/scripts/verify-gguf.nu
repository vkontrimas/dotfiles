#!/usr/bin/env nu
#
# Verify a downloaded GGUF against the SHA256 HuggingFace has on record for
# it, fetched live from the HF tree API — not hardcoded here — so nothing
# stale or hand-copied can drift from what's actually in the repo.
#
# Usage:
#   nu verify-gguf.nu
#   nu verify-gguf.nu --repo prism-ml/Ternary-Bonsai-27B-gguf --filename Ternary-Bonsai-27B-Q2_0.gguf --dir /home/kinetic/data/llm-models/bonsai

def main [
    --repo: string = "prism-ml/Ternary-Bonsai-27B-gguf"
    --filename: string = "Ternary-Bonsai-27B-Q2_0.gguf"
    --dir: string = "/home/kinetic/data/llm-models/bonsai"
] {
    let file = $"($dir)/($filename)"

    if not ($file | path exists) {
        print $"error: file not found: ($file)"
        exit 1
    }

    print $"fetching expected sha256 for ($filename) from huggingface.co/($repo)..."
    let entry = (
        http get $"https://huggingface.co/api/models/($repo)/tree/main"
        | where path == $filename
    )

    if ($entry | is-empty) {
        print $"error: ($filename) not found in ($repo)'s file listing"
        exit 1
    }

    let expected = ($entry | get 0.lfs.oid)
    print $"expected \(HF API\): ($expected)"

    print "computing local sha256 — this can take a while on a multi-GB file..."
    let actual = (sha256sum $file | split row " " | first)
    print $"actual   \(local\):    ($actual)"

    if $expected == $actual {
        print "OK — checksum matches"
    } else {
        print "MISMATCH — re-download the file"
        exit 1
    }
}
