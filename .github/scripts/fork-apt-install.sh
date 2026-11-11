#!/usr/bin/env bash
# Fork-only: installs Ubuntu packages on GitHub-hosted ubuntu-24.04 runners
# with a hard time bound. See FORK.md "Pull request runners".
#
# On 2026-11-11 Canonical's nameservers stopped answering, so the runners
# could not resolve *.ubuntu.com and apt hung on its sources. This script skips
# apt when the packages are installed. Otherwise it tries mirrors in order,
# skips any host that does not resolve, and gives each a hard time budget.
# Indexes stay signed by the Ubuntu archive keyring on every mirror.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: fork-apt-install.sh <package>..." >&2
  exit 2
fi
packages=("$@")

missing() {
  local package
  for package in "${packages[@]}"; do
    dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed' || echo "$package"
  done
}

need=$(missing)
if [ -z "$need" ]; then
  echo "Already installed: ${packages[*]}"
  exit 0
fi
echo "Missing: $(echo "$need" | tr '\n' ' ')"

scratch=$(mktemp -d -t fork-apt.XXXXXXXX)
trap 'sudo rm -rf -- "$scratch"' EXIT
chmod 755 "$scratch"

for mirror in azure.archive.ubuntu.com/ubuntu mirrors.edge.kernel.org/ubuntu archive.ubuntu.com/ubuntu; do
  host=${mirror%%/*}
  if ! timeout 5 getent hosts "$host" > /dev/null; then
    echo "Skipping $host: it does not resolve" >&2
    continue
  fi
  budget=60
  attempt="$scratch/$host"
  mkdir -m 755 "$attempt" "$attempt/lists" "$attempt/lists/partial"
  for suite in noble noble-updates noble-security; do
    echo "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://$mirror $suite main universe"
  done > "$attempt/ubuntu.list"
  options=(
    -o "Dir::Etc::sourcelist=$attempt/ubuntu.list"
    -o 'Dir::Etc::sourceparts=-'
    -o "Dir::State::lists=$attempt/lists"
    -o 'Acquire::Languages=none'
    -o 'Acquire::Retries=0'
    -o 'Acquire::http::Timeout=5'
    -o 'Acquire::https::Timeout=5'
    -o 'APT::Update::Error-Mode=any'
  )
  echo "Installing from $mirror (update and install budget: ${budget}s)"
  start=$SECONDS
  # timeout signals its whole process group, so apt's download methods stop too.
  if sudo env PACKAGES="$need" timeout -k 5 "$budget" bash -c '
      apt-get "$@" update &&
        DEBIAN_FRONTEND=noninteractive apt-get "$@" install -y --no-install-recommends $PACKAGES
    ' apt "${options[@]}" < /dev/null \
    && [ -z "$(missing)" ]; then
    echo "Installed ${packages[*]} from $mirror in $((SECONDS - start))s"
    exit 0
  fi
  echo "Could not install from $mirror after $((SECONDS - start))s" >&2
done
echo "Still missing after every mirror: $(missing | tr '\n' ' ')" >&2
exit 1
