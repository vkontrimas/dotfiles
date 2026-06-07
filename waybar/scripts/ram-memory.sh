#!/bin/bash
read -r used total < <(free -b | awk 'NR==2{print $3, $2}')
if [[ -n "$used" && -n "$total" ]]; then
  echo "$((used/1073741824))/$((total/1073741824))GB"
fi
