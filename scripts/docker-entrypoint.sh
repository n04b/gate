#!/bin/sh
# Container entrypoint.
#
# Bind-mounted directories keep their host ownership, and Docker creates a
# missing bind-mount source as root:root, so /data often arrives unwritable for
# the unprivileged user Gate runs as. When started as root this script fixes the
# ownership of Gate's own state and then drops privileges: the Gate process
# itself never runs as root.
#
# Started with a `user:` override in compose, it changes nothing and simply
# execs — an unwritable path is then reported by the config bootstrap.
set -eu

APP_UID="${PUID:-1000}"
APP_GID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  # Only Gate's own state. The mounted config directory belongs to the operator
  # and is never chowned from inside the container.
  if [ -d /data ] && ! chown -R "$APP_UID:$APP_GID" /data 2>/dev/null; then
    echo "gate: cannot change ownership of /data; continuing as uid $APP_UID" >&2
  fi

  exec su-exec "$APP_UID:$APP_GID" "$@"
fi

exec "$@"
