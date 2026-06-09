#!/bin/bash
export SWAY_UNSUPPORTED_GPU=1
exec ssh-agent sway "$@"
