#!/bin/bash
# Sourced by entrypoint: retain the service's numeric UID/GID for bind mounts,
# while giving OpenSSH (getpwuid) a user record. No root bootstrap or chown.
worker_identity_init() {
  local uid gid missing_user=0 missing_group=0 library identity_dir username groupname
  uid="$(id -u)"
  gid="$(id -g)"
  getent passwd "$uid" >/dev/null || missing_user=1
  getent group "$gid" >/dev/null || missing_group=1
  if (( missing_user == 0 && missing_group == 0 )); then
    return 0
  fi

  library=/usr/local/lib/libnss_wrapper.so
  if [[ ! -r "$library" ]]; then
    echo "Worker identity: missing libnss_wrapper for UID=$uid GID=$gid" >&2
    return 1
  fi

  # Private, unique files in the container writable layer; keep them alive across
  # exec for SSH and other child processes. Container removal cleans them up.
  identity_dir="$(mktemp -d /tmp/vh-worker-identity.XXXXXXXX)" || return 1
  if ! (
    umask 077
    cat /etc/passwd > "$identity_dir/passwd" &&
    cat /etc/group > "$identity_dir/group"
  ); then
    echo "Worker identity: cannot copy user database" >&2
    return 1
  fi

  if (( missing_user )); then
    if [[ "$HOME" == *:* || "$HOME" == *$'\n'* || "$HOME" == *$'\r'* ]]; then
      echo "Worker identity: HOME cannot contain passwd field separators" >&2
      return 1
    fi
    username="vh-worker-$uid"
    while getent passwd "$username" >/dev/null; do username="${username}_"; done
    printf '%s:x:%s:%s:VulnHunter worker:%s:/bin/bash\n' \
      "$username" "$uid" "$gid" "$HOME" >> "$identity_dir/passwd" || return 1
  fi
  if (( missing_group )); then
    groupname="vh-worker-$gid"
    while getent group "$groupname" >/dev/null; do groupname="${groupname}_"; done
    printf '%s:x:%s:\n' "$groupname" "$gid" >> "$identity_dir/group" || return 1
  fi

  export NSS_WRAPPER_PASSWD="$identity_dir/passwd"
  export NSS_WRAPPER_GROUP="$identity_dir/group"
  export LD_PRELOAD="$library${LD_PRELOAD:+:$LD_PRELOAD}"
  if ! getent passwd "$uid" >/dev/null || ! getent group "$gid" >/dev/null; then
    echo "Worker identity: user lookup still fails for UID=$uid GID=$gid" >&2
    return 1
  fi
}

worker_identity_init || return $?
unset -f worker_identity_init
