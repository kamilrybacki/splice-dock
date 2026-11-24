#!/bin/sh
set -e

# tini is PID 1 and forwards signals; this script ends by exec-ing node.
#
# Started as root (plain `docker run`): create the state directories, give
# them to the node user, then drop to it. Volumes written by v1.0.0, which ran
# as root, hold root-owned files, so ownership is fixed on every start; only
# entries not already owned by node are touched.
#
# Started as another user (Kubernetes runAsUser, `docker run --user`): run as
# that user and leave ownership to the platform (fsGroup, volume permissions).
# The image itself does not create these directories: a `--tmpfs` mount over a
# directory that exists in the image takes that directory's mode, which would
# lock out a non-root user.
if [ "$(id -u)" = 0 ]; then
  for dir in /var/splicedock/data /var/splicedock/bin; do
    if mkdir -p "$dir" 2>/dev/null; then
      find "$dir" -xdev ! -user node -exec chown -h node:node {} + 2>/dev/null \
        || echo "entrypoint: could not give $dir to the node user" >&2
    fi
  done
  # Without CAP_SETUID/CAP_SETGID (e.g. --cap-drop ALL) the drop is impossible;
  # keep the v1.0.0 behaviour rather than refuse to start.
  if setpriv --reuid=node --regid=node --init-groups -- true 2>/dev/null; then
    export HOME=/home/node USER=node
    exec setpriv --reuid=node --regid=node --init-groups -- node /app/dist/main.js
  fi
  echo "entrypoint: cannot switch to the node user (missing capabilities); running as root" >&2
fi

exec node /app/dist/main.js
