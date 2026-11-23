#!/usr/bin/env bash
# Installs the Panel Stats GNOME Shell extension for the current user.
# Works both from a git clone and standalone:
#   ./install.sh
#   curl -fsSL https://raw.githubusercontent.com/st2l/gnome-panel-stats/main/install.sh | bash
set -euo pipefail

UUID="panel-stats@st2l.github.io"
REPO="st2l/gnome-panel-stats"
BRANCH="${PANEL_STATS_BRANCH:-main}"
TARGET="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

say() { printf '\033[1;32m==>\033[0m %s\n' "$1"; }
die() {
  printf '\033[1;31merror:\033[0m %s\n' "$1" >&2
  exit 1
}

command -v glib-compile-schemas >/dev/null 2>&1 ||
  die "glib-compile-schemas not found. Install glib2 development tools (Debian/Ubuntu: libglib2.0-bin, Fedora: glib2-devel, Arch: glib2)."

script_dir=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [[ -n "${script_dir}" && -f "${script_dir}/${UUID}/metadata.json" ]]; then
  source_dir="${script_dir}/${UUID}"
  say "Installing from ${source_dir}"
else
  command -v curl >/dev/null 2>&1 || die "curl not found, and no local source directory next to this script."
  download_dir="$(mktemp -d)"
  trap 'rm -rf "${download_dir}"' EXIT
  say "Downloading ${REPO} (${BRANCH})"
  curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}" |
    tar -xz -C "${download_dir}" --strip-components=1
  source_dir="${download_dir}/${UUID}"
  [[ -f "${source_dir}/metadata.json" ]] || die "Downloaded archive does not contain ${UUID}."
fi

say "Copying files to ${TARGET}"
rm -rf "${TARGET}"
mkdir -p "${TARGET}"
cp -r "${source_dir}/." "${TARGET}/"

say "Compiling GSettings schema"
glib-compile-schemas --strict "${TARGET}/schemas"

if command -v gnome-extensions >/dev/null 2>&1; then
  say "Enabling the extension"
  for _ in 1 2 3 4 5; do
    if gnome-extensions enable "${UUID}" 2>/dev/null; then
      say "Enabled. The indicator appears in the left part of the top bar."
      exit 0
    fi
    sleep 1
  done
fi

cat <<MSG

Files are in place, but the extension could not be enabled automatically.
Finish with:

  1. log out and log back in (Wayland) or press Alt+F2, type 'r', press Enter (X11)
  2. gnome-extensions enable ${UUID}

MSG
