#!/bin/bash
output=$(nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits -i 0 2>/dev/null)
used=$(echo "$output" | cut -d',' -f1 | tr -d ' ')
total=$(echo "$output" | cut -d',' -f2 | tr -d ' ')
if [[ -n "$used" && -n "$total" ]]; then
  echo "$((used/1024))/$((total/1024))GB"
fi
