#!/bin/bash
# Waybar emby-server status toggle.
#   button → JSON with text + class for current service state
#   toggle → start or stop the emby docker container
COMPOSE_FILE="$HOME/dotfiles/docker/emby/docker-compose.yml"

DOCKER=/usr/sbin/docker

case "$1" in
  button)
    if $DOCKER compose -f "$COMPOSE_FILE" ps --format json 2>/dev/null | grep -q '"State":"running"'; then
      echo '{"text": "EMBY", "class": "online"}'
    else
      echo '{"text": "EMBY", "class": "offline"}'
    fi
    ;;
  toggle)
    if $DOCKER compose -f "$COMPOSE_FILE" ps --format json 2>/dev/null | grep -q '"State":"running"'; then
      $DOCKER compose -f "$COMPOSE_FILE" down
    else
      $DOCKER compose -f "$COMPOSE_FILE" up -d
    fi
    ;;
esac
