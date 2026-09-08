#!/bin/bash
# Run INSIDE a built worker image, e.g. (on the authorized test host):
# docker run --rm -i --network none --user 1001:1001 \
#   -e HOME=/tmp/worker-home --entrypoint bash IMAGE < scripts/tests/worker-identity-smoke.sh
# Matrix: 0:0, 1000:1000, 1001:1001, 65001:65002, 1000:65002.
set -euo pipefail

uid="$(id -u)"
gid="$(id -g)"
had_user=0
had_group=0
getent passwd "$uid" >/dev/null && had_user=1
getent group "$gid" >/dev/null && had_group=1
original_passwd="$(sha256sum /etc/passwd)"
original_group="$(sha256sum /etc/group)"
mkdir -p "$HOME"
source /opt/worker-identity.sh

[[ "$(id -u)" == "$uid" && "$(id -g)" == "$gid" ]]
[[ "$(getent passwd "$uid" | cut -d: -f3)" == "$uid" ]]
[[ "$(getent group "$gid" | cut -d: -f3)" == "$gid" ]]
getent passwd root >/dev/null
getent passwd node >/dev/null
[[ "$(sha256sum /etc/passwd)" == "$original_passwd" ]]
[[ "$(sha256sum /etc/group)" == "$original_group" ]]
if (( had_user && had_group )); then
  [[ -z "${NSS_WRAPPER_PASSWD:-}" && -z "${LD_PRELOAD:-}" ]]
else
  [[ -r "$NSS_WRAPPER_PASSWD" && -r "$NSS_WRAPPER_GROUP" ]]
  [[ "$(stat -c %a "$(dirname "$NSS_WRAPPER_PASSWD")")" == 700 ]]
  [[ "$(stat -c %a "$NSS_WRAPPER_PASSWD")" == 600 ]]
  [[ "$(stat -c %a "$NSS_WRAPPER_GROUP")" == 600 ]]
fi

# This does not contact a server. It reproduces the exact pre-connection
# getpwuid failure, and verifies inherited identity in a new process.
bash -c 'ssh -G -F /dev/null -o BatchMode=yes root@127.0.0.1 >/dev/null'
python3 -c 'import os,pwd,grp; assert pwd.getpwuid(os.getuid()).pw_uid == os.getuid(); assert grp.getgrgid(os.getgid()).gr_gid == os.getgid()'
file="$(mktemp "$HOME/identity-write.XXXXXXXX")"
printf 'identity-test\n' > "$file"
[[ "$(stat -c %u "$file")" == "$uid" && "$(stat -c %g "$file")" == "$gid" ]]
rm -- "$file"
printf 'PASS UID=%s GID=%s: user lookup, inherited SSH, unchanged identity and write ownership\n' "$uid" "$gid"
