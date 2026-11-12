# shellcheck shell=bash
# closet's extra docs rules, sourced by devkit/bin/docs_check.sh after its standard checks (pair
# shape, size caps, decisions log, retired tools); contract in that script's header. Uses its
# $agents_files (every tracked AGENTS.md, root first-class) and docs_fail.
#
# The area index: the root AGENTS.md is loaded by every session, an area's AGENTS.md only when
# a file in its directory is read (#104), so the root's "### Area index" section is how an agent
# planning work finds an area's doc. Every area doc must be named there in backticks, and every
# `<path>/AGENTS.md` (or CLAUDE.md) the root names anywhere must exist: a stale pointer misleads
# wherever it is (#119). devkit/ is vendored and has its own doc, so it is not an area.

closet_area_index() {
  awk '
    $0 == "### Area index" { inside = 1; next }
    inside && /^#/ { exit }
    inside { print }
  ' AGENTS.md
}

closet_index=$(closet_area_index)
if [ -z "$closet_index" ]; then
  docs_fail "AGENTS.md has no \"### Area index\" section"
else
  # shellcheck disable=SC2154  # agents_files is set by docs_check.sh, which sources this file
  for closet_doc in ${agents_files[@]+"${agents_files[@]}"}; do
    case "$closet_doc" in AGENTS.md|devkit/*) continue ;; esac
    case "$closet_index" in
      *"\`$closet_doc\`"*) ;;
      *) docs_fail "$closet_doc is not in AGENTS.md's area index" ;;
    esac
  done
fi

# shellcheck disable=SC2016  # the backticks are literal Markdown, not an expansion
while IFS= read -r closet_named; do
  [ -e "$closet_named" ] || docs_fail "AGENTS.md names $closet_named, which does not exist"
done < <(grep -oE '`[A-Za-z0-9_./-]+/(AGENTS|CLAUDE)\.md`' AGENTS.md | tr -d '`' | sort -u)

# Kept until devkit's docs-check runs check_public_topology for GATE_PUBLIC plans (#482): docs-only
# commits and PRs run docs-check alone, so devkit-check never sees them. Drop it at that sync.
# The public tree names no homelab topology (2026-11-12, "Homelab topology lives in the homelab
# repo"): this repo is public and forked, and production's addresses, paths and hostnames belong in
# homelab's stacks/closet/README.md. Refused: a 192.168/16 address outside a spec (an SSRF spec
# needs one; a docs example uses 192.0.2.0/24), a NAS volume or the owner's home path, a dynamic-DNS
# or tailnet suffix, the owner's public domain, and a tailnet hostname (2026-11-12, "Tailnet
# hostnames are role words"), specs included: a fixture host is `nas.example`. A bare `<name>.box`
# is refused in Markdown and after `://`, `@` or a backtick elsewhere, since thumb.box is also a
# property access; a named host needs a left boundary so debug.box is not one. The dated history
# (decisions.md, PROJECT_LOG.md, docs/reports/, docs/audits/) is exempt from the hostnames only
# (devkit-check scans it). devkit/ is vendored: a hit there is fixed in devkit and synced. No `\b`: git
# grep on macOS has no GNU regex extensions. This file is skipped: it quotes the patterns.
# devkit-check scans this file too, so the quoted host pattern carries its exemption comment.
closet_hosts='linux-box|((^|[^a-z0-9_.-])(nas|bug|closet|redlib)|(://|@|`)[a-z0-9.-]+)\.box([^a-z0-9_]|$)' # topology example
closet_history=(':!docs/decisions.md' ':!docs/PROJECT_LOG.md' ':!docs/reports' ':!docs/audits')
while IFS= read -r closet_leak; do
  docs_fail "public tree names homelab topology: $closet_leak (move it to homelab stacks/closet/README.md)"
done < <({
  git grep -nIoE '192\.168\.[0-9]+\.[0-9]+|\.dedyn\.io|\.duckdns\.org|\.ts\.net|kashhq\.com|/volume[0-9]+/|/(home|Users)/aakash' \
    -- . ':!devkit' ':!*.spec.ts' ':!scripts/ci/docs_rules.sh'
  git grep -nIoiE "$closet_hosts" \
    -- . ':!devkit' ':!scripts/ci/docs_rules.sh' "${closet_history[@]}"
  git grep -nIoiE '[a-z0-9-]+\.box([^a-z0-9_]|$)' -- '*.md' ':!devkit' "${closet_history[@]}"
} | cut -d: -f1,2 | sort -u)
