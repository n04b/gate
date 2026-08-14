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
  # Directories Gate must be able to write: its state volume and the config
  # directory it may have to seed. A read-only mount simply fails the chown and
  # is reported later by the config bootstrap.
  for dir in /data /app/config; do
    [ -d "$dir" ] || continue
    if ! chown -R "$APP_UID:$APP_GID" "$dir" 2>/dev/null; then
      echo "gate: cannot change ownership of $dir; continuing as uid $APP_UID" >&2
    fi
  done

  exec su-exec "$APP_UID:$APP_GID" "$@"
fi

exec "$@"
