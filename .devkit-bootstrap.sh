#!/usr/bin/env bash
# Copy unchanged to .devkit-bootstrap.sh at a pinned consumer's root (devkit-sync refreshes it;
# devkit-check holds it byte-equal to devkit/templates/bootstrap/devkit-bootstrap.sh).
# Fills the untracked, gitignored devkit/ with exactly the devkit .devkit-rev pins
# (`<commit> <tree>`): that commit's VENDOR_PATHS, from a bare clone of devkit shared by every
# checkout of this user on this host. Design: devkit docs/plans/2026-11-13-stop-vendoring.md.
#
# Exit, a contract (check_tree.sh and publish.sh read only 1 as the commit's fault, red; the
# rest as the box's, never a red commit):
#   0  devkit/ matches the pin (materialized, already current, or --check passed).
#   1  only the pin itself is wrong, a fact about the pinned commit: a malformed .devkit-rev, a
#      commit devkit lacks after a fetch that reached it, a commit whose VENDOR_PATHS lists
#      nothing or whose tree is not the pinned tree (the cache verified first by git fsck).
#      --check also exits 1 for its verdict: devkit/ differs from the pin.
#   2  everything else: usage, no .devkit-rev, devkit unreachable, disk or I/O, a failed
#      archive or tar, a failed write (.devkit-files, the stamp), a corrupt cache, a lock held
#      600s, a missing tool, an unexpected error. The default: only refuse() exits 1, and the
#      EXIT trap turns any other failure into 2.
#
# Usage: .devkit-bootstrap.sh [--rev <commit> --tree <tree>] [--into <dir>]
#        .devkit-bootstrap.sh --check [--rev <commit> --tree <tree>] [--into <dir>]
#        .devkit-bootstrap.sh --git-dir --rev <commit>
#   default pin: .devkit-rev beside this script; default <dir>: devkit/ beside it.
#   --check    no git fetch, no write: exit 1 unless the files the bootstrap extracted into <dir>
#              (its .devkit-files) hash to the pinned tree and its stamp names the pin
#              (devkit-check: a local edit or deletion fails it; a tool's node_modules or cache,
#              which no pin lists, does not).
#   --git-dir  make sure <commit> is cached, print the cache's git dir, materialize nothing
#              (_vendor_paths.sh: a pin's base copies and tree, judged in the cache).
#
# Runs before anything can provision a toolchain (every make, the hooks, check_tree), so: bash
# 3.2, git and tar only. Fast path: the stamp <dir>/.devkit-materialized equals the pin: exit 0,
# silent, no git. Otherwise one line on stderr, `devkit: <sha7> materialized (cached|fetched) in
# <n>s`. The tree is hashed from the extracted files and must equal the pin's tree field: a
# corrupt cache or a hand-edited pin is refused, never materialized. One swap per <dir> at a
# time (the lock <dir>.lock beside it); <dir> never goes missing during one, and its stamp is
# written last.
#
# Cache: ${DEVKIT_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/devkit}/devkit.git, cloned from
# DEVKIT_URL (default https://github.com/kashhq/devkit.git; git's own credential helper). A
# commit it lacks fetches every head, then the commit by id (a PR branch's, for a canary), under
# a mkdir lock (flock is not on every host). Offline, a cached commit still materializes; an
# uncached one is exit 2 (the box, not the commit: check_tree's ENV_CAUSES has the line), never
# a fallback to another devkit.
#
# Make, at the top of every pinned Makefile (GNU make remakes an included file, then restarts;
# SHELL is /bin/sh here because the repo's SHELL lives under devkit/bin). The stamp file is a
# prerequisite with an empty rule, so a deleted stamp remakes the include and re-runs the bootstrap
# (silent when current). A tree damaged by hand with the stamp left in place is not detected:
# `rm -rf devkit` heals it. devkit-check requires these lines exactly:
#   include devkit/.devkit-materialized.mk
#   devkit/.devkit-materialized.mk: SHELL := /bin/sh
#   devkit/.devkit-materialized.mk: .devkit-rev .devkit-bootstrap.sh devkit/.devkit-materialized ; @./.devkit-bootstrap.sh && touch $@
#   devkit/.devkit-materialized: ;
# macOS's make 3.81 says `devkit/.devkit-materialized.mk: No such file or directory` once in a
# fresh worktree before remaking it; harmless. Not `-include`: that would hide a failed bootstrap.
set -uo pipefail

# A hook's git environment is not this script's (devkit #502): git exports GIT_INDEX_FILE, GIT_DIR,
# GIT_WORK_TREE, GIT_OBJECT_DIRECTORY and the like to pre-commit and commit-msg hooks and to
# everything they run, so a bootstrap run from one would write devkit's files into the commit's
# own index. Every git call below names its own repo (--git-dir, -C, a scratch store).
# shellcheck disable=SC2046  # the names are words
unset $(git rev-parse --local-env-vars 2>/dev/null)

# The exit contract (above). die is the box's, refuse the pin's; nothing else exits 1.
REFUSED=''
die() { echo "devkit: $1" >&2; exit 2; }
refuse() { echo "devkit: $1" >&2; REFUSED=1; exit 1; }
# Locks: a mkdir (flock is not on every host) holding the holder's pid. One per cache (one
# fetcher) and, materializing, one per <dir> beside it (one swap per checkout: two makes in a
# fresh worktree once nested their copies). The EXIT trap releases only this process's, so a lock
# released and since taken by another process survives this one's exit.
CACHE_LOCK='' SWAP_LOCK='' NEW='' OLD=''
unlock() { [ -z "$1" ] || [ "$(cat "$1/pid" 2>/dev/null)" != $$ ] || rm -rf "$1"; }
cleanup() {
  local rc=$?
  [ -z "$NEW" ] || rm -rf "$NEW"
  [ -z "$OLD" ] || rm -rf "$OLD"
  unlock "$CACHE_LOCK"
  unlock "$SWAP_LOCK"
  # A set -u slip, a failed command's own status 1, a signal: the box's, never the pin's.
  if [ "$rc" != 0 ] && { [ "$rc" != 1 ] || [ -z "$REFUSED" ]; }; then exit 2; fi
}
trap cleanup EXIT

HERE=$(cd "$(dirname "$0")" && pwd) || die "cannot resolve the directory of $0"
URL=${DEVKIT_URL:-https://github.com/kashhq/devkit.git}
CACHE=${DEVKIT_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/devkit}/devkit.git
STAMP=.devkit-materialized
# The pinned files, NUL-separated, as extracted: what --check hashes (anything else a tool writes
# under devkit/, node_modules or a lint cache, is not devkit's and never fails it).
FILES=.devkit-files
MODE=materialize REV='' TREE='' INTO=$HERE/devkit

usage() { echo "usage: $0 [--check | --git-dir] [--rev <commit> [--tree <tree>]] [--into <dir>]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --git-dir) MODE=git-dir ;;
    --rev|--tree|--into)
      [ $# -ge 2 ] && [ -n "$2" ] || usage
      case "$1" in --rev) REV=$2 ;; --tree) TREE=$2 ;; *) INTO=$2 ;; esac
      shift ;;
    *) usage ;;
  esac
  shift
done
# <dir> canonical: absolute, no trailing slash. `$TMP/devkit/` once put the temporaries below
# inside devkit/ and the swap moved devkit/ into itself (pr_merge.sh, devkit #501).
while :; do case "$INTO" in ?*/) INTO=${INTO%/} ;; *) break ;; esac; done
case "$INTO" in /) usage ;; /*) ;; *) INTO=$PWD/$INTO ;; esac
if [ -z "$REV" ]; then
  [ -z "$TREE" ] || usage
  [ -f "$HERE/.devkit-rev" ] || die "no .devkit-rev beside $0, and no --rev"
  [ -r "$HERE/.devkit-rev" ] || die "cannot read $HERE/.devkit-rev"
  read -r REV TREE _ <"$HERE/.devkit-rev"
  [ -n "$TREE" ] || [ "$MODE" = git-dir ] || refuse ".devkit-rev names no tree ('<commit> <tree>'); fix it (make devkit-sync)"
fi
[ -n "$TREE" ] || [ "$MODE" = git-dir ] || usage
case "$REV" in *[!0-9a-f]*|'') refuse "the pinned commit '$REV' is not a full commit id" ;; esac
[ "${#REV}" = 40 ] || refuse "the pinned commit '$REV' is not a full commit id"
case "$TREE" in *[!0-9a-f]*) refuse "the pinned tree '$TREE' is not a tree id" ;; esac
SHA7=${REV:0:7}

current() { [ "$(cat "$INTO/$STAMP" 2>/dev/null)" = "$REV $TREE" ]; }
# Fast path: before any git call, since make and every hook run it.
if [ "$MODE" = materialize ] && current; then exit 0; fi

# tree_of_files <dir> <list>: the tree hash of exactly the files <list> names (NUL-separated,
# relative to <dir>), hashed in a throwaway object store so neither the cache nor the consumer's
# repo (nor its ignores) is read. Returns 1 when a listed file is missing, 2 when the scratch
# store cannot be made (the box).
tree_of_files() {
  local scratch tree rc=0
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/devkit-tree.XXXXXX") || return 2
  git init -q --bare "$scratch/git" || { rm -rf "$scratch"; return 2; }
  GIT_DIR=$scratch/git GIT_INDEX_FILE=$scratch/index GIT_WORK_TREE=$1 git -C "$1" -c core.autocrlf=false -c core.fileMode=true \
    -c core.symlinks=true update-index -z --add --stdin <"$2" 2>/dev/null \
    && tree=$(GIT_DIR=$scratch/git GIT_INDEX_FILE=$scratch/index git write-tree) || rc=1
  rm -rf "$scratch"
  [ "$rc" = 0 ] && echo "$tree"
}

# --check's 1 is its verdict (devkit/ is not the pin's); only a scratch store it cannot make is 2.
if [ "$MODE" = check ]; then
  [ -d "$INTO" ] || refuse "$INTO is not materialized; run ./.devkit-bootstrap.sh (make install does)"
  [ -f "$INTO/$FILES" ] \
    || refuse "$INTO has no $FILES (materialized by an older bootstrap). Restore it: rm -rf $INTO && ./.devkit-bootstrap.sh"
  rc=0
  have=$(tree_of_files "$INTO" "$INTO/$FILES") || rc=$?
  [ "$rc" != 2 ] || die "cannot make a scratch git store under ${TMPDIR:-/tmp} to hash $INTO"
  [ "$rc" = 0 ] \
    || refuse "$INTO lacks a pinned file of $SHA7 (or git cannot hash it); a change belongs upstream in devkit. Restore it: rm -rf $INTO && ./.devkit-bootstrap.sh"
  [ "$have" = "$TREE" ] || refuse "$INTO (tree ${have:0:7}) differs from the pinned ${TREE:0:7} of $SHA7; a change belongs upstream in devkit. Restore it: rm -rf $INTO && ./.devkit-bootstrap.sh"
  current || refuse "$INTO/$STAMP does not name the pin $SHA7; run ./.devkit-bootstrap.sh"
  exit 0
fi

CACHE_LOCK=$CACHE.lock SWAP_LOCK=$INTO.lock
# lock <dir>: wait for it, up to 600s, saying so once. A holder whose pid is gone left it behind
# (killed); break_stale clears it for exactly one waiter.
lock() {
  local waited=0 holder said=''
  until mkdir "$1" 2>/dev/null; do
    if [ ! -e "$1" ]; then mkdir "$1" 2>/dev/null && break; [ -e "$1" ] || die "cannot create $1"; fi
    holder=$(cat "$1/pid" 2>/dev/null)
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null && break_stale "$1" "$holder"; then continue; fi
    [ "$waited" -lt 600 ] || die "$1 is held by pid ${holder:-?} for 600s; remove it if that process is gone"
    [ -n "$said" ] || { echo "devkit: waiting for $1 (held by pid ${holder:-?})" >&2; said=1; }
    sleep 1
    waited=$((waited + 1))
  done
  echo $$ >"$1/pid" || die "cannot write $1/pid"
}
# break_stale <lock> <dead pid>: clear the lock <dead pid> left, or return 1. Two waiters can both
# read the dead pid, and by the time the second acts the first may hold a fresh lock under the same
# name, so a plain rm could delete a live lock. The claim, a mkdir inside the lock, admits one
# waiter per lock instance; the claimant then checks the pid is still the dead one (not a lock
# retaken since, nor one whose new holder has not written its pid yet) before moving it aside.
# Nothing else removes a dead holder's lock, so it cannot change between that check and the mv.
# A claimant killed mid-break leaves its claim: the lock then times out (600s, exit 2).
break_stale() {
  mkdir "$1/broken" 2>/dev/null || return 1
  if [ "$(cat "$1/pid" 2>/dev/null)" != "$2" ]; then
    rmdir "$1/broken" 2>/dev/null
    return 1
  fi
  rm -rf "$1.stale.$$"
  mv "$1" "$1.stale.$$" || die "cannot move the stale $1 aside"
  rm -rf "$1.stale.$$"
  echo "devkit: $1 was left by pid $2, which is gone; cleared it" >&2
}

cached() { git --git-dir="$CACHE" cat-file -e "$REV^{commit}" 2>/dev/null; }
# git_net: a fetch never prompts and gives up on a stalled link instead of hanging the caller.
git_net() { LC_ALL=C GIT_TERMINAL_PROMPT=0 git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 "$@"; }

# fetch: REV into the cache, or exit (2 when devkit is unreachable, 1 when it lacks REV).
fetch() {
  mkdir -p "$(dirname "$CACHE")" || die "cannot create $(dirname "$CACHE")"
  lock "$CACHE_LOCK"
  cached && { unlock "$CACHE_LOCK"; return 0; }  # another run fetched it while this one waited
  if [ ! -d "$CACHE" ]; then
    rm -rf "$CACHE.tmp.$$"
    if ! git_net clone -q --bare "$URL" "$CACHE.tmp.$$" 2>/dev/null; then
      rm -rf "$CACHE.tmp.$$"
      die "$SHA7 is not cached and $URL is unreachable; connect and rerun"
    fi
    mv "$CACHE.tmp.$$" "$CACHE" || die "cannot move the new clone to $CACHE"
  else
    git_net --git-dir="$CACHE" fetch -q --prune --no-tags "$URL" '+refs/heads/*:refs/heads/*' 2>/dev/null \
      || die "$SHA7 is not cached and $URL is unreachable; connect and rerun"
  fi
  # The heads fetch reached devkit; a commit it did not bring (one on no head) is asked for by id.
  # Only devkit saying it has no such commit is the pin's (1). A server that refuses fetch by id
  # gets one more full heads fetch, and a commit still missing after a complete one is the pin's;
  # any other failure (the network dropping mid-way) says nothing about the pin: exit 2.
  if ! cached; then
    err=$(git_net --git-dir="$CACHE" fetch -q --no-tags "$URL" "$REV" 2>&1 >/dev/null) || {
      case $err in
        *"not our ref"*|*"couldn't find remote ref"*|*"no such commit"*|*"not found"*|*"not a valid object name"*) ;;
        *"unadvertised object"*|*"does not allow"*)
          git_net --git-dir="$CACHE" fetch -q --no-tags "$URL" '+refs/heads/*:refs/heads/*' 2>/dev/null \
            || die "$SHA7 is not cached and refetching $URL failed; connect and rerun" ;;
        *) die "$SHA7 is not cached and fetching it from $URL failed: ${err##*$'\n'}; connect and rerun" ;;
      esac
    }
  fi
  cached || refuse "$URL has no commit $REV; fix .devkit-rev (make devkit-sync)"
  unlock "$CACHE_LOCK"
}

T0=$SECONDS
if [ "$MODE" = materialize ]; then
  mkdir -p "$(dirname "$INTO")" || die "cannot create $(dirname "$INTO")"
  lock "$SWAP_LOCK"
  current && exit 0  # another run materialized the pin while this one waited
fi
HOW=cached
cached || { fetch; HOW=fetched; }
[ "$MODE" = git-dir ] && { echo "$CACHE"; exit 0; }

# The commit's own VENDOR_PATHS, read as bin/_vendor_paths.sh reads it; a devkit from before the
# manifest (2026-10-13) is taken whole, as devkit-sync vendored it.
PATHS=()
if MANIFEST=$(git --git-dir="$CACHE" show "$REV:VENDOR_PATHS" 2>/dev/null); then
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%%#*}
    line=${line//[[:space:]]/}
    [ -z "$line" ] || PATHS+=("${line%/}")
  done <<<"$MANIFEST"
  [ "${#PATHS[@]}" -gt 0 ] || refuse "$SHA7's VENDOR_PATHS lists nothing"
fi

NEW=$INTO.tmp.$$ OLD=$INTO.old.$$
rm -rf "$NEW" "$OLD"
mkdir -p "$NEW" || die "cannot create $NEW"
git --git-dir="$CACHE" archive "$REV" -- ${PATHS[@]+"${PATHS[@]}"} | tar -x -C "$NEW" \
  || die "cannot extract $SHA7 from $CACHE into $NEW (git or tar above)"
git --git-dir="$CACHE" ls-tree -r -z --name-only "$REV" -- ${PATHS[@]+"${PATHS[@]}"} >"$NEW/$FILES" \
  || die "cannot write $NEW/$FILES, $SHA7's file list (above)"
HAVE=$(tree_of_files "$NEW" "$NEW/$FILES") || die "cannot hash the extracted $SHA7 (git above)"
# Another tree is the pin's fault only once the cache is proven sound: a damaged object can
# extract to other bytes, and that is the box's.
if [ "$HAVE" != "$TREE" ]; then
  git --git-dir="$CACHE" fsck --no-dangling --no-progress "$REV" >/dev/null 2>&1 \
    || die "$SHA7 materializes tree ${HAVE:0:7}, not the pinned ${TREE:0:7}, and $CACHE fails git fsck: a corrupt cache, not the pin. Remove it and rerun"
  refuse "$SHA7 materializes tree ${HAVE:0:7}, but .devkit-rev pins ${TREE:0:7}; refusing (a hand-edited pin)"
fi
{ echo "$REV $TREE" >"$NEW/$STAMP" && echo "DEVKIT_REV := $REV" >"$NEW/$STAMP.mk"; } || die "cannot write $NEW/$STAMP"

# move_entries <from> <to>: every entry of <from>, dotfiles too, the stamp aside, into <to>.
move_entries() {
  local e
  for e in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    { [ -e "$e" ] || [ -L "$e" ]; } && [ "${e##*/}" != "$STAMP" ] || continue
    mv "$e" "$2/" || die "cannot move $e to $2"
  done
}
# The swap, under the lock: <dir> itself never goes missing. Its stamp leaves first, so a
# concurrent fast path sees "not current" and waits on the lock; then the old entries move aside,
# the new ones in, and the stamp lands last, naming a complete tree.
if [ -L "$INTO" ] || { [ -e "$INTO" ] && [ ! -d "$INTO" ]; }; then
  die "$INTO is not a directory; remove it and rerun"
elif [ -d "$INTO" ]; then
  mkdir "$OLD" || die "cannot create $OLD"
  if [ -e "$INTO/$STAMP" ]; then mv "$INTO/$STAMP" "$OLD/" || die "cannot move $INTO/$STAMP aside"; fi
  move_entries "$INTO" "$OLD"
  move_entries "$NEW" "$INTO"
  mv "$NEW/$STAMP" "$INTO/$STAMP" || die "cannot move $NEW/$STAMP to $INTO"
else
  mv "$NEW" "$INTO" || die "cannot move $NEW to $INTO"
fi
echo "devkit: $SHA7 materialized ($HOW) in $((SECONDS - T0))s" >&2
