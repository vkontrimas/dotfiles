#!/bin/bash
gpu0_out=$(nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits -i 0 2>/dev/null)
gpu0_used=$(echo "$gpu0_out" | cut -d',' -f1 | tr -d ' ')
gpu0_total=$(echo "$gpu0_out" | cut -d',' -f2 | tr -d ' ')

gpu1_out=$(nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits -i 1 2>/dev/null)
gpu1_used=$(echo "$gpu1_out" | cut -d',' -f1 | tr -d ' ')
gpu1_total=$(echo "$gpu1_out" | cut -d',' -f2 | tr -d ' ')

if [[ -n "$gpu0_used" && -n "$gpu0_total" ]]; then
  echo "$((gpu0_used/1024))/$((gpu0_total/1024))GB $((gpu1_used/1024))/$((gpu1_total/1024))GB"
fi