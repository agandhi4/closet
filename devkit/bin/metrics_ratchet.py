#!/usr/bin/env python3
"""Metrics report: a committed bound per metric, and how far the tree is from each.

REPORT ONLY (owner, 2026-11-13; devkit docs/decisions.md): nothing here gates a PR, a deploy or
a push. The numbers are for cleanup rounds: run `make ci-metrics` and read what moved against the
bounds, then `tighten` the gains you want to keep. Why it was a gate before, and why it is not:
a per-PR ratchet cost every PR a tighten commit, a label for a tool-driven loosening and a red
main for noise, to guard numbers that a periodic round can read just as well.

`check` prints one line per tracked metric and exits 0 whatever it finds. `tighten` and
`rebaseline` stay as the tools that write bounds; nothing requires running them.

Report-only keys (`vuln.*`, `meta.*`, `coupling.<scope>.fan_in_max`,
`duplication.<scope>.jscpd_percent`,
`size.<scope>.max_lines`, `size.<scope>.over_600`, `images.<scope>.refs` and
`images.<scope>.unpinned`; is_report_only), plus any key its collector
declares report-only (a top-level `"report_only": [<its keys>]` list in its output, carried into
the snapshot by `merge`: ts.mjs declares a Next build's `bundle.<scope>.kb_total`, while a vite
build's is a plain key; Snapshot.is_report_only): collected and printed as REPORT-ONLY, never
compared, even when a bounds file still holds one. `tighten` and `rebaseline` drop such a bound
and seed none. With `--report-only FILE`, `tighten` and `rebaseline` also write the snapshot's
report-only keys to FILE, a schema 2 snapshot (metrics_collect.sh passes
docs/metrics/report-only.json): build/metrics.json is untracked, so this committed copy is what a
fresh clone's scorecard reads. `check` never writes it and never reads it. Why fan-in
(2026-10-17): a models or core hub has many importers by design, so its count is architecture, not
drift. Why jscpd_percent (2026-10-17): it rises when unduplicated lines are deleted;
`duplication.<scope>.clones` is the duplication key. Why size (owner 2026-10-18): a long file is
printed for a reader, and size alone never justifies a split.

`tighten` moves each bound the snapshot beats to its value; a float key better by at most
LOCK_IN_TOLERANCE, or a floor by at most FLOOR_SLACK, stays (gain_to_lock_in), so noise is never
committed. `rebaseline --keys K1,K2` loosens only the named bounds, each only when the snapshot
is WORSE (a named key with no bound is seeded); without `--keys` the whole file is rewritten and
a WARNING names every bound it loosened. `tighten --seed` adds a bound at today's value for every
snapshot key without one, with its domain's direction (seed_bounds); first adoption from `{}` is
`tighten --seed` too.

Usage:
  metrics_ratchet.py check --snapshot S --bounds B [--show-untracked]
  metrics_ratchet.py tighten --snapshot S --bounds B [--report-only F] [--seed]
  metrics_ratchet.py rebaseline --snapshot S --bounds B [--report-only F] [--keys K1,K2]
  metrics_ratchet.py merge --out OUT [--skipped NAME]... [--] [INPUT.json...]
  metrics_ratchet.py tightens --base-bounds F --head-bounds F
  metrics_ratchet.py floors --bounds B [--tier T]

Key shape (docs/metrics-keys.md): flat dotted keys `<domain>.<scope>.<stat>`, numbers only,
no whitespace. A collector file may also be nested objects (flattened to dotted keys) or
finplat's `make metrics` envelope `{"commit": ..., "metrics": {nested}, "schema_version": 1}`;
lists, strings, booleans and nulls are not metrics and are skipped, matching finplat's
`_flatten`. `merge` turns the collector outputs (each at least one number) into one snapshot;
a key two collectors both emit is an error, not a silent overwrite. metrics_collect.sh passes
its conf's `build/metrics/<name>.json`, gate.json and tier-*.json, never the whole directory.

The snapshot `merge` writes (schema 2) names where each key came from, so `check` can tell a
collector that did not run from a metric that vanished:
  {"schema_version": 2, "metrics": {<flat>}, "sources": {"<key>": "<collector>"},
   "skipped": ["<collector>", ...][, "report_only": ["<key>", ...]]}
`report_only` (absent when empty) is the union of the inputs' declarations; a collector may
declare only keys it emits. `<collector>` is the input file's stem
(`build/metrics/python-backend.json` -> `python-backend`; tier_guard's `tier-unit.json` is a
source too). `skipped` lists collectors a caller marked as not run (`merge --skipped`). `check`,
`tighten` and `rebaseline` read schema 2, schema 1 and a flat file alike; only
schema 2 carries sources and skips, so a schema 1 or flat snapshot gets the all-MISSING reading.

Bounds (`docs/metrics/ratchet.json`): `{"<metric>": {"direction": "lower"|"higher",
"bound": <number>|null[, "source": "<collector>"]}}`. "lower" reads WORSE when value > bound;
"higher" when value < bound. `null` exists only in the starter (templates/metrics/ratchet.json):
`rebaseline` fills it, `check` refuses it (exit 2: a copied template has no bounds to compare).
`rebaseline` also seeds every snapshot key the bounds do not track yet (except the `gate` and
`tier` domains and the report-only keys, which it drops) with the direction its domain fixes
(DOMAIN_DIRECTIONS, the docs/metrics-keys.md table); a key of an unknown domain is an error
naming it. `rebaseline` and `tighten` copy `source` from the snapshot into every bound they write;
`check` uses it only to recognise a skipped collector. An empty bounds file `{}` is valid.

Output: one `ratchet <metric> <value> vs <bound> SAME|BETTER|WORSE|MISSING` line per tracked
metric, or `ratchet <metric> - vs <bound> SKIPPED (collector <name> did not run)` when the bound's
source is in the snapshot's `skipped`, `ratchet <metric> <value>|- vs <bound> REPORT-ONLY (...)`
for a report-only bound, `ratchet <metric> <value> UNSEEDED` for a floor with no bound;
`ratchet untracked <n>` (each listed with --show-untracked), a summary line and a closing
`ratchet report only: ...` line. A tracked metric absent for a reason other than a skipped
collector is MISSING.

Floors (2026-10-26): `tests.<tier>.<runner>`, tier_guard.sh's count of the tests a tier ran, is
bounded `higher`: the bound IS the tier's floor, which tier_guard.sh reads (`floors`) and reports
against (a FLOOR line, never a failure: 2026-11-13). A gain locks in only past FLOOR_SLACK of the
bound. `tighten` seeds an unbounded floor key without --seed. A tier the gate did not run writes
no tier-<tier> file, so a floor whose tier-* source emitted nothing reads SKIPPED, not MISSING.

`tightens` (a devkit sync's bounds, 2026-10-28) exits 0 when the head file differs from the base
only by TIGHTENED bounds, else 1 naming each other move (_vendor_paths.sh devkit_sync_only).

Exit codes: 0 ok (`check` and `tighten` report and exit 0 whatever the numbers), 1 `rebaseline`
cannot run because a tracked metric is absent, or `tightens` found a move that is not a
tightening, 2 usage error or unreadable/invalid file.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

EXIT_OK = 0
EXIT_RATCHET = 1
EXIT_USAGE = 2

DIRECTIONS = ("lower", "higher")
# The domain table of docs/metrics-keys.md: what `rebaseline` seeds an untracked key with.
# Keep the two in step; a domain missing here is a key the repo tracks by hand.
DOMAIN_DIRECTIONS = {
    "coverage": "higher",
    "duplication": "lower",
    "dead": "lower",
    "complexity": "lower",
    "coupling": "lower",
    "guards": "lower",
    "bundle": "lower",
    "statements": "lower",
    "size": "lower",
    "vuln": "lower",
    "images": "lower",
    "allowlist": "lower",
    "lint": "lower",
    "meta": "lower",
    "tests": "higher",
}
# Never seeded by rebaseline (docs/metrics-keys.md): the seconds are noisy. A repo may still
# track one by hand, with headroom.
NEVER_SEEDED_DOMAINS = frozenset({"gate", "tier"})
# Test-count floors (module docstring, Floors). Seeded by a plain tighten; a gain locks in only
# past FLOOR_SLACK of the bound (rounded down: a 3-test suite locks in every gain).
FLOOR_DOMAIN = "tests"
FLOOR_SLACK = 0.05
# tier_guard.sh's files, build/metrics/tier-<tier>.json: written only by a tier that ran.
TIER_SOURCE_PREFIX = "tier-"
# Report-only (module docstring): never gated, whatever the bounds file says. `vuln` moves with
# a new advisory, not a code change; fan-in of a hub is architecture, not drift; a duplicated
# share rises when unduplicated lines are deleted; a file's length alone never justifies a split.
# `meta` describes the measurement (files a collector's --exclude left out), not the code.
# Image refs grow with each service; unpinned images are the compose-pinned-image guard's, whose
# per-service exceptions (the fleet's `:latest` deploy pointers) a count cannot hold.
REPORT_ONLY_DOMAINS = frozenset({"vuln", "meta"})
REPORT_ONLY_STATS = frozenset(  # (domain, last key segment)
    {
        ("coupling", "fan_in_max"),
        ("duplication", "jscpd_percent"),
        ("images", "refs"),
        ("images", "unpinned"),
        ("size", "max_lines"),
        ("size", "over_600"),
    }
)
# How far a float key may beat its bound before check demands a tighten (module docstring).
# Integer keys (counts) have none: any gain is real and deterministic.
LOCK_IN_TOLERANCE = 0.05


class InputError(Exception):
    """A snapshot, bounds file or base ref that is missing, malformed or invalid (exit 2)."""


@dataclass(frozen=True)
class Bound:
    direction: str
    bound: float | None  # None only before the first rebaseline (the starter template)
    source: str | None = None  # the collector that emitted the key, from a schema 2 snapshot


@dataclass(frozen=True)
class Snapshot:
    values: dict[str, float]
    sources: dict[str, str]  # key -> collector; empty for a schema 1 or flat snapshot
    skipped: frozenset[str]  # collectors metrics_collect.sh did not run; empty likewise
    # Keys their collector declared report-only (module docstring): a property of how this
    # build was measured, which the key's name cannot carry (bundle.*.kb_total is gated for vite).
    report_only: frozenset[str] = frozenset()
    # A schema 2 snapshot (merge's envelope) names every key's source, so a source it lacks did
    # not emit; a schema 1 or flat one says nothing either way.
    provenance: bool = False

    def is_report_only(self, metric: str) -> bool:
        """Never gated: by name (is_report_only) or by its collector's declaration."""
        return is_report_only(metric) or metric in self.report_only

    @property
    def ran(self) -> frozenset[str]:
        """The collectors that emitted at least one key."""
        return frozenset(self.sources.values())


SNAPSHOT_SCHEMA = 2


def _is_number(value: object) -> bool:
    # bool is an int subclass; `true` is never a measurement.
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _parse_json(text: str, what: str) -> object:
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise InputError(f"{what} is not valid JSON: {exc}") from exc


def _read_json(path: Path, what: str) -> object:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise InputError(f"cannot read {what} {path}: {exc.strerror}") from exc
    return _parse_json(text, f"{what} {path}")


def _check_key(key: str, where: str) -> None:
    # Output lines are space-separated (`ratchet <metric> <value> ...`); a key with whitespace
    # would make them ambiguous for every reader that splits them.
    if not key or any(ch.isspace() for ch in key):
        raise InputError(f"{where}: metric key {key!r} is empty or contains whitespace")


def _flatten(node: object, prefix: str = "") -> dict[str, float]:
    if isinstance(node, dict):
        out: dict[str, float] = {}
        for key, value in node.items():
            out.update(_flatten(value, f"{prefix}.{key}" if prefix else str(key)))
        return out
    if _is_number(node) and prefix:
        return {prefix: node}
    return {}


def _collector_name(value: object, where: str) -> str:
    # Printed in `ratchet ... SKIPPED (collector <name> did not run)`: the same no-whitespace
    # rule as a metric key, for the same reason.
    if not isinstance(value, str) or not value or any(ch.isspace() for ch in value):
        raise InputError(f"{where}: collector name {value!r} must be a word without whitespace")
    return value


def load_snapshot(path: Path, *, allow_empty: bool = False) -> Snapshot:
    """A collector file or a merged snapshot. A collector file (a `merge` input) must hold at
    least one number: an empty one is a collector that printed something else. The merged
    snapshot may be empty (no collector declared yet), so the callers that read it allow it."""
    doc = _read_json(path, "snapshot")
    if not isinstance(doc, dict):
        raise InputError(f"snapshot {path} must be a JSON object")
    sources: dict[str, str] = {}
    skipped: frozenset[str] = frozenset()
    provenance = False
    declared = _declared_report_only(doc, path)
    # An envelope: only `metrics` holds measurements; `commit` and `schema_version` would
    # otherwise flatten into bogus metrics (commit.dirty is skipped, schema_version not).
    if "schema_version" in doc and isinstance(doc.get("metrics"), dict):
        if doc["schema_version"] == SNAPSHOT_SCHEMA:
            raw_sources, raw_skipped = doc.get("sources", {}), doc.get("skipped", [])
            if not isinstance(raw_sources, dict) or not isinstance(raw_skipped, list):
                raise InputError(f"snapshot {path}: `sources` must be an object, `skipped` a list")
            where = f"snapshot {path}"
            sources = {k: _collector_name(v, where) for k, v in raw_sources.items()}
            skipped = frozenset(_collector_name(n, where) for n in raw_skipped)
            provenance = True
        doc = doc["metrics"]
    values = _flatten(doc)
    if not values and not allow_empty:
        raise InputError(f"snapshot {path} contains no numeric metrics")
    undeclared = sorted(declared - set(values))
    if undeclared:
        raise InputError(f"snapshot {path}: report_only names {', '.join(undeclared)}, which it does not emit")
    return Snapshot(
        values=values, sources=sources, skipped=skipped, report_only=declared, provenance=provenance
    )


def _declared_report_only(doc: dict[str, object], path: Path) -> frozenset[str]:
    """The top-level `report_only` list of a collector file or schema 2 snapshot (module
    docstring); empty when absent. _flatten skips it, as it skips every list."""
    raw = doc.get("report_only", [])
    if not isinstance(raw, list) or not all(isinstance(key, str) for key in raw):
        raise InputError(f"snapshot {path}: `report_only` must be a list of metric keys")
    for key in raw:
        _check_key(key, f"snapshot {path} report_only")
    return frozenset(raw)


def parse_bounds(doc: object, where: str) -> dict[str, Bound]:
    if not isinstance(doc, dict):
        raise InputError(f"bounds {where} must be a JSON object")
    bounds: dict[str, Bound] = {}
    for metric, entry in doc.items():
        _check_key(metric, f"bounds {where}")
        if not isinstance(entry, dict) or set(entry) - {"source"} != {"direction", "bound"}:
            raise InputError(
                f"bounds {where}: {metric} must be exactly "
                '{"direction": ..., "bound": ...[, "source": ...]}'
            )
        direction, bound, source = entry["direction"], entry["bound"], entry.get("source")
        if source is not None:
            _collector_name(source, f"bounds {where}: {metric} source")
        if direction not in DIRECTIONS:
            raise InputError(
                f"bounds {where}: {metric} direction {direction!r} is not one of "
                f"{', '.join(DIRECTIONS)}"
            )
        if bound is not None and not _is_number(bound):
            raise InputError(f"bounds {where}: {metric} bound {bound!r} is not a number")
        bounds[metric] = Bound(direction=direction, bound=bound, source=source)
    return bounds


def load_bounds(path: Path) -> dict[str, Bound]:
    return parse_bounds(_read_json(path, "bounds"), str(path))


def _atomic_write(path: Path, text: str) -> None:
    # Atomic replace: a crash mid-write must not leave a truncated committed file. The directory
    # may not exist yet: a first-adoption rebaseline of a hand-built repo creates docs/metrics/.
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except OSError:
        Path(tmp).unlink(missing_ok=True)
        raise


def write_bounds(path: Path, bounds: dict[str, Bound]) -> None:
    doc = {}
    for metric, b in bounds.items():
        doc[metric] = {"direction": b.direction, "bound": b.bound}
        if b.source is not None:
            doc[metric]["source"] = b.source
    _atomic_write(path, json.dumps(doc, indent=2, sort_keys=True) + "\n")


def _write_envelope(
    path: Path,
    values: dict[str, float],
    sources: dict[str, str],
    skipped: list[str],
    report_only: Iterable[str] = (),
) -> None:
    """A schema 2 snapshot: what `merge` writes and what the report-only file is."""
    doc: dict[str, object] = {
        "schema_version": SNAPSHOT_SCHEMA,
        "metrics": values,
        "sources": sources,
        "skipped": sorted(set(skipped)),
    }
    if declared := sorted(set(report_only)):
        doc["report_only"] = declared
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(path, json.dumps(doc, indent=2, sort_keys=True) + "\n")


def write_report_only(path: Path, snapshot: Snapshot) -> None:
    """Commit the report-only keys beside the bounds (docs/metrics/report-only.json), so the
    scorecard of a fresh clone has them (devkit #76): the bounds never hold one, and
    build/metrics.json is untracked. A key whose collector was skipped keeps its committed
    value. A repo that collects no such key and has no file gets none."""
    old = load_snapshot(path, allow_empty=True) if path.is_file() else None
    values: dict[str, float] = {}
    sources: dict[str, str] = {}
    if old is not None:
        for metric, value in old.values.items():
            if old.sources.get(metric) in snapshot.skipped:
                values[metric], sources[metric] = value, old.sources[metric]
    for metric, value in snapshot.values.items():
        if snapshot.is_report_only(metric):
            values[metric] = value
            if metric in snapshot.sources:
                sources[metric] = snapshot.sources[metric]
    if old is None and not values:
        return
    _write_envelope(path, values, sources, [])
    print(f"ratchet report-only {len(values)} key(s) written to {path} (commit it with the bounds)")


def _with_value(metric: str, bound: Bound, snapshot: Snapshot) -> Bound:
    """The bound moved to the snapshot's value, carrying the snapshot's source for the key (a
    schema 1 or flat snapshot has none, and then the bound keeps the source it had)."""
    return Bound(
        direction=bound.direction,
        bound=snapshot.values[metric],
        source=snapshot.sources.get(metric, bound.source),
    )


def skipped_collector(metric: str, bound: Bound, snapshot: Snapshot) -> str | None:
    """The collector that would have measured `metric` but did not run, else None. A bound
    whose `source` is in the snapshot's `skipped` qualifies, and so does one whose source is a
    tier file that emitted nothing (a tier the gate did not run; module docstring, Floors): a
    key with no source (bounds written before schema 2) or whose collector ran is MISSING."""
    if metric in snapshot.values or bound.source is None:
        return None
    if bound.source in snapshot.skipped:
        return bound.source
    # Only a schema 2 snapshot says which sources emitted: a flat one reads MISSING.
    if (
        snapshot.provenance
        and bound.source.startswith(TIER_SOURCE_PREFIX)
        and bound.source not in snapshot.ran
    ):
        return bound.source
    return None


def is_floor(metric: str) -> bool:
    return metric.partition(".")[0] == FLOOR_DOMAIN


def is_report_only(metric: str) -> bool:
    parts = metric.split(".")
    return parts[0] in REPORT_ONLY_DOMAINS or (parts[0], parts[-1]) in REPORT_ONLY_STATS


def seedable(metric: str, snapshot: Snapshot) -> bool:
    """A key `rebaseline` and `tighten --seed` may add a bound for: not a never-seeded domain,
    not report-only."""
    return metric.partition(".")[0] not in NEVER_SEEDED_DOMAINS and not snapshot.is_report_only(metric)


def seed_bound(metric: str, snapshot: Snapshot, bounds_path: Path) -> Bound:
    """A first bound for a seedable key, at its value, with the direction its domain fixes. A
    key of a domain the table lacks is an error naming it: the repo adds it by hand."""
    domain = metric.partition(".")[0]
    direction = DOMAIN_DIRECTIONS.get(domain)
    if direction is None:
        raise InputError(
            f"snapshot key {metric}: domain {domain!r} has no direction in "
            f"docs/metrics-keys.md; add the key to {bounds_path} by hand with its direction"
        )
    return Bound(direction, snapshot.values[metric], snapshot.sources.get(metric))


def seed_bounds(
    snapshot: Snapshot, bounds: dict[str, Bound], bounds_path: Path, *, floors_only: bool = False
) -> dict[str, Bound]:
    """A first bound for every seedable snapshot key the bounds do not track (rebaseline, and
    tighten under --seed), in key order; with floors_only, the floor keys alone (a plain
    tighten)."""
    return {
        metric: seed_bound(metric, snapshot, bounds_path)
        for metric in sorted(set(snapshot.values) - set(bounds))
        if seedable(metric, snapshot) and (is_floor(metric) or not floors_only)
    }


SEED_HINT = "`make metrics-tighten SEED=1`"


def _drop_report_only(metric: str, bound: Bound) -> None:
    """The line `tighten` and `rebaseline` print for a report-only bound they drop."""
    print(f"ratchet {metric} {_fmt(bound.bound)} -> - (dropped: report-only, never gated)")


def _fail(message: str) -> None:
    """A FAIL line on stderr, after everything already printed: stdout is block-buffered in a
    pipe (metrics_collect.sh), so without the flush the line can land above the keys it names."""
    sys.stdout.flush()
    print(message, file=sys.stderr)


def is_better(a: float, b: float, direction: str) -> bool:
    """True when `a` is strictly better than `b` under `direction`."""
    return a < b if direction == "lower" else a > b


def classify(value: float, bound: float, direction: str) -> str:
    if value == bound:
        return "SAME"
    return "BETTER" if is_better(value, bound, direction) else "WORSE"


def lock_in_slack(metric: str, value: float, bound: float) -> float:
    """How far `value` may beat `bound` before check demands a tighten: FLOOR_SLACK of the
    bound on a floor, none on any other integer key (its gain is deterministic and real),
    LOCK_IN_TOLERANCE on a float key."""
    if is_floor(metric):
        return int(bound * FLOOR_SLACK)
    return 0 if isinstance(value, int) and isinstance(bound, int) else LOCK_IN_TOLERANCE


def gain_to_lock_in(metric: str, value: float, bound: float) -> bool:
    """True when a BETTER value must be committed as the bound before check passes."""
    return abs(value - bound) > lock_in_slack(metric, value, bound)


def _fmt(value: float | None) -> str:
    if value is None:
        return "unset"
    return str(value) if isinstance(value, int) else repr(value)


def _status_line(metric: str, bound: Bound, snapshot: Snapshot) -> str:
    """Print check's `ratchet <metric> ...` line for a compared bound and return its status
    (SAME, BETTER, WORSE, MISSING, SKIPPED). `tighten` prints the same lines for what it leaves."""
    if metric not in snapshot.values:
        collector = skipped_collector(metric, bound, snapshot)
        if collector is None:
            print(f"ratchet {metric} - vs {_fmt(bound.bound)} MISSING")
            return "MISSING"
        print(
            f"ratchet {metric} - vs {_fmt(bound.bound)} SKIPPED (collector {collector} did not run)"
        )
        return "SKIPPED"
    value = snapshot.values[metric]
    if bound.bound is None:  # check refuses unset bounds first; tighten fills them
        raise InputError(f"{metric}: bound unset")
    status = classify(value, bound.bound, bound.direction)
    note = ""
    if status == "BETTER":  # tighten reaches here only with a gain within the tolerance
        note = (
            " — make metrics-tighten locks it in"
            if gain_to_lock_in(metric, value, bound.bound)
            else f" (within tolerance {_fmt(lock_in_slack(metric, value, bound.bound))})"
        )
    print(f"ratchet {metric} {_fmt(value)} vs {_fmt(bound.bound)} {status}{note}")
    return status


def cmd_check(args: argparse.Namespace) -> int:
    """Print every tracked metric against its bound, and exit 0 whatever it finds (module
    docstring: report only). Only an unreadable file or a placeholder bound is an error."""
    snapshot = load_snapshot(Path(args.snapshot), allow_empty=True)
    bounds_path = Path(args.bounds)
    bounds = load_bounds(bounds_path)
    unset = sorted(m for m, b in bounds.items() if b.bound is None and not snapshot.is_report_only(m))
    if unset:
        raise InputError(
            f"bounds {bounds_path}: {', '.join(unset)} unset; run `metrics_ratchet.py rebaseline` "
            "to take the first bounds from a snapshot"
        )

    counts = {"SAME": 0, "BETTER": 0, "WORSE": 0, "MISSING": 0, "SKIPPED": 0, "REPORT-ONLY": 0}
    for metric in sorted(bounds):
        bound = bounds[metric]
        if snapshot.is_report_only(metric):
            counts["REPORT-ONLY"] += 1
            value = snapshot.values.get(metric)
            print(
                f"ratchet {metric} {'-' if value is None else _fmt(value)} vs {_fmt(bound.bound)} "
                "REPORT-ONLY (moved to report-only, never compared; "
                "run make metrics-tighten to drop it)"
            )
            continue
        counts[_status_line(metric, bound, snapshot)] += 1

    untracked = sorted(set(snapshot.values) - set(bounds))
    if args.show_untracked:
        for metric in untracked:
            print(f"ratchet {metric} {_fmt(snapshot.values[metric])} UNTRACKED")
    for metric in untracked:
        if is_floor(metric):
            print(
                f"ratchet {metric} {_fmt(snapshot.values[metric])} UNSEEDED (a test-count floor: "
                f"make metrics-tighten seeds it into {bounds_path})"
            )
    print(
        f"ratchet summary same={counts['SAME']} better={counts['BETTER']} "
        f"worse={counts['WORSE']} missing={counts['MISSING']} skipped={counts['SKIPPED']} "
        f"untracked={len(untracked)} report_only={counts['REPORT-ONLY']}"
    )
    print(
        f"ratchet report only: {counts['WORSE']} worse and {counts['MISSING']} missing vs "
        f"{bounds_path}; nothing fails on them (a cleanup round reads this; make metrics-tighten "
        "locks in the gains)"
    )
    return EXIT_OK


def cmd_tighten(args: argparse.Namespace) -> int:
    """Move every bound the snapshot beats to the snapshot value; never loosen any. A
    report-only bound is dropped (no label needed: check ignores it against main). With --seed,
    every seedable key without a bound gains one at its value, and every floor key does without
    it. Every WORSE and MISSING key prints check's line; the exit is 0 (report only)."""
    snapshot = load_snapshot(Path(args.snapshot), allow_empty=True)
    bounds_path = Path(args.bounds)
    bounds = load_bounds(bounds_path)
    # Resolved before anything is written: an unknown domain is exit 2 with the file untouched.
    # Floors are seeded without --seed (module docstring, Floors).
    seeds = seed_bounds(snapshot, bounds, bounds_path, floors_only=not args.seed)
    tightened = dict(bounds)
    changed = dropped = 0
    failing = {"WORSE": 0, "MISSING": 0}
    for metric in sorted(bounds):
        bound = bounds[metric]
        if snapshot.is_report_only(metric):
            del tightened[metric]
            dropped += 1
            _drop_report_only(metric, bound)
            continue
        value = snapshot.values.get(metric)
        # gain_to_lock_in, the predicate check fails on: a float gain within the tolerance stays
        # at the old bound, or noise locked in (closet coverage 92.47 -> 92.48) reads WORSE at
        # the next gate's 92.47.
        if value is not None and (
            bound.bound is None
            or (is_better(value, bound.bound, bound.direction)
                and gain_to_lock_in(metric, value, bound.bound))
        ):
            tightened[metric] = _with_value(metric, bound, snapshot)
            changed += 1
            print(f"ratchet {metric} {_fmt(bound.bound)} -> {_fmt(value)}")
            continue
        status = _status_line(metric, bound, snapshot)
        if status in failing:
            failing[status] += 1
    for metric, seed in seeds.items():
        tightened[metric] = seed
        print(f"ratchet {metric} SEEDED {_fmt(seed.bound)}")
    if changed or dropped or seeds:
        write_bounds(bounds_path, tightened)
    notes = [f"{len(seeds)} seeded"] if seeds else []
    if dropped:
        notes.append(f"{dropped} report-only dropped")
    notes_s = f" ({', '.join(notes)})" if notes else ""
    print(f"ratchet tightened {changed} bound(s) in {bounds_path}{notes_s}")
    if not args.seed:
        untracked = sorted(set(snapshot.values) - set(tightened))
        unbounded = [m for m in untracked if seedable(m, snapshot)]
        if unbounded:
            print(
                f"ratchet untracked {len(unbounded)} key(s) without a bound "
                f"({', '.join(unbounded)}); {SEED_HINT} adds them at today's value"
            )
    if args.report_only:
        write_report_only(Path(args.report_only), snapshot)
    if any(failing.values()):
        print(
            f"ratchet report only: {failing['WORSE']} worse and {failing['MISSING']} missing "
            f"vs {bounds_path}; nothing fails on them ({SEED_HINT} bounds a renamed key's new name)"
        )
    return EXIT_OK


def _parse_keys(text: str) -> list[str]:
    keys = [k.strip() for k in text.split(",") if k.strip()]
    if not keys:
        raise InputError("--keys names no key (want K1[,K2...])")
    for key in keys:
        _check_key(key, "--keys")
    return sorted(set(keys))


def rebaseline_keys(
    keys: list[str], snapshot: Snapshot, bounds: dict[str, Bound], bounds_path: Path
) -> dict[str, Bound] | None:
    """Loosen exactly `keys` to their measured values where WORSE, and seed a named key that has
    no bound yet; None when none moved."""
    for key in keys:
        if snapshot.is_report_only(key):
            raise InputError(f"--keys {key}: report-only, never gated; nothing to loosen")
        if key not in bounds:
            if key not in snapshot.values:
                raise InputError(
                    f"--keys {key}: not a bound in {bounds_path} and not in the snapshot"
                )
            if not seedable(key, snapshot):
                raise InputError(f"--keys {key}: its domain is never bounded (gate, tier)")
        elif key not in snapshot.values:
            collector = skipped_collector(key, bounds[key], snapshot)
            why = f"collector {collector} did not run" if collector else "absent from it"
            raise InputError(f"--keys {key}: the snapshot did not measure it ({why})")
    rebased = dict(bounds)
    loosened = 0
    seeded = 0
    for key in keys:
        value = snapshot.values[key]
        if key not in bounds:
            rebased[key] = seed_bound(key, snapshot, bounds_path)
            seeded += 1
            print(f"ratchet {key} SEEDED {_fmt(value)}")
            continue
        bound = bounds[key]
        status = "WORSE" if bound.bound is None else classify(value, bound.bound, bound.direction)
        if status == "WORSE":
            rebased[key] = _with_value(key, bound, snapshot)
            loosened += 1
            print(f"ratchet {key} {_fmt(bound.bound)} -> {_fmt(value)} LOOSENED")
        else:
            print(
                f"ratchet {key} {_fmt(value)} vs {_fmt(bound.bound)} {status} (not worse; "
                "left as is: `make metrics-tighten` locks in a better number)"
            )
    seeded_note = f", seeded {seeded}" if seeded else ""
    print(f"ratchet rebaselined {loosened} of {len(keys)} named bound(s) in {bounds_path}"
          f"{seeded_note}; no other bound moved")
    return rebased if loosened or seeded else None


def cmd_rebaseline(args: argparse.Namespace) -> int:
    """Overwrite every tracked bound with the snapshot value, or with --keys only the named
    ones (rebaseline_keys). A bound whose collector was skipped is left as it is (there is no
    value to take); any other absent key is an error."""
    snapshot = load_snapshot(Path(args.snapshot), allow_empty=True)
    bounds_path = Path(args.bounds)
    # First adoption (a hand-built repo; metrics_collect.sh header): every key is seeded, and the
    # file exists only once this run writes it.
    first = args.keys is None and not bounds_path.exists()
    bounds = {} if first else load_bounds(bounds_path)
    if first:
        print(f"ratchet: no {bounds_path}: first adoption, every key is bounded at today's value")
    if args.keys is not None:
        keyed = rebaseline_keys(_parse_keys(args.keys), snapshot, bounds, bounds_path)
        if keyed is not None:
            write_bounds(bounds_path, keyed)
        if args.report_only:
            write_report_only(Path(args.report_only), snapshot)
        return EXIT_OK
    missing = sorted(
        m
        for m, b in bounds.items()
        if m not in snapshot.values
        and skipped_collector(m, b, snapshot) is None
        and not snapshot.is_report_only(m)
    )
    if missing:
        for metric in missing:
            print(f"ratchet {metric} - vs {_fmt(bounds[metric].bound)} MISSING")
        print(
            f"ratchet FAIL: cannot rebaseline {len(missing)} metric(s) absent from the snapshot; "
            f"remove or rename them in {bounds_path}",
            file=sys.stderr,
        )
        return EXIT_RATCHET
    rebased: dict[str, Bound] = {}
    dropped = 0
    loosened: list[str] = []
    for metric in sorted(bounds):
        bound = bounds[metric]
        if snapshot.is_report_only(metric):
            dropped += 1
            _drop_report_only(metric, bound)
            continue
        if metric in snapshot.values:
            rebased[metric] = _with_value(metric, bound, snapshot)
            print(f"ratchet {metric} {_fmt(bound.bound)} -> {_fmt(rebased[metric].bound)}")
            if bound.bound is not None and classify(
                snapshot.values[metric], bound.bound, bound.direction
            ) == "WORSE":
                loosened.append(metric)
        else:
            rebased[metric] = bound
            print(
                f"ratchet {metric} - vs {_fmt(bound.bound)} SKIPPED "
                f"(collector {bound.source} did not run) (left as is)"
            )
    # Seed what the snapshot has and the bounds do not, so adoption starts from `{}`: every
    # key except the never-seeded domains and the report-only keys, with the direction its
    # domain fixes.
    seeds = seed_bounds(snapshot, bounds, bounds_path)
    for metric, seed in seeds.items():
        rebased[metric] = seed
        print(f"ratchet {metric} - -> {_fmt(seed.bound)} (seeded, {seed.direction})")
    seeded = len(seeds)
    write_bounds(bounds_path, rebased)
    if args.report_only:
        write_report_only(Path(args.report_only), snapshot)
    dropped_note = f", {dropped} report-only dropped" if dropped else ""
    print(
        f"ratchet rebaselined {len(rebased)} bound(s) in {bounds_path} "
        f"({seeded} seeded{dropped_note})"
    )
    if loosened:
        _fail(
            f"ratchet WARNING: the whole-file rebaseline loosened {len(loosened)} bound(s): "
            f"{', '.join(loosened)}. To loosen only the keys this PR moved, restore "
            f"{bounds_path} and run `make metrics-rebaseline KEYS=<key>[,<key>]`"
        )
    return EXIT_OK


def cmd_merge(args: argparse.Namespace) -> int:
    merged: dict[str, float] = {}
    owner: dict[str, str] = {}  # key -> input path, for the clash message
    sources: dict[str, str] = {}  # key -> collector (the input's stem), for the envelope
    declared: set[str] = set()
    for skipped in args.skipped:
        _collector_name(skipped, "merge --skipped")
    for name in args.inputs:
        collected = load_snapshot(Path(name))
        declared |= collected.report_only
        for key, value in collected.values.items():
            _check_key(key, f"snapshot {name}")
            if key in owner:
                raise InputError(f"metric {key} is emitted by both {owner[key]} and {name}")
            owner[key] = name
            sources[key] = Path(name).stem
            merged[key] = value
    out = Path(args.out)
    _write_envelope(out, merged, sources, args.skipped, declared)
    skipped = sorted(set(args.skipped))
    skipped_note = f"; skipped: {', '.join(skipped)}" if skipped else ""
    print(
        f"ratchet merged {len(merged)} metric(s) from {len(args.inputs)} file(s) into {out}"
        f"{skipped_note}"
    )
    return EXIT_OK


def cmd_floors(args: argparse.Namespace) -> int:
    """The test-count floors, `<tier> <runner> <min>` per tests.<tier>.<runner> bound in key
    order, of one tier with --tier: tier_guard.sh's floors, and the tiers metrics_collect.sh
    needs a fresh tier-<tier>.json from. <min> is the bound less its FLOOR_SLACK: the bound is
    the gate machine's count, and a tier run elsewhere (Actions, another box) may skip a test
    that depends on its environment (closet's model-gated spec); `check` in the gate holds the
    exact bound. A floor that is not a whole number or not `higher` is exit 2: a hand edit both
    could only misread."""
    bounds_path = Path(args.bounds)
    for metric, bound in sorted(load_bounds(bounds_path).items()):
        domain, _, rest = metric.partition(".")
        tier, _, runner = rest.partition(".")
        if domain != FLOOR_DOMAIN or not runner or "." in runner or bound.bound is None:
            continue
        if args.tier is not None and tier != args.tier:
            continue
        if bound.direction != "higher" or bound.bound != int(bound.bound):
            raise InputError(
                f"bounds {bounds_path}: floor {metric} must be a whole number, direction higher"
            )
        floor = int(bound.bound) - int(lock_in_slack(metric, bound.bound, bound.bound))
        print(f"{tier} {runner} {floor}")
    return EXIT_OK


REPORT_ONLY_HELP = (
    "also write the snapshot's report-only keys to FILE (docs/metrics/report-only.json), the "
    "committed copy the scorecard reads"
)


def _not_a_tightening(metric: str, old: Bound | None, new: Bound | None) -> str | None:
    """Why an entry that differs between base and head is not a tightening, or None when it
    is: the same gated key, direction and source, its bound strictly better. Stricter than
    bound_moves, which lets `source` and report-only keys move: a source starting `tier-` reads
    a missing key SKIPPED (skipped_collector), so changing one can waive a MISSING failure."""
    if old is None or new is None:
        return "ADDED" if old is None else "REMOVED"
    if is_report_only(metric):
        return "REPORT-ONLY"
    if new.direction != old.direction:
        return "DIRECTION"
    if new.source != old.source:
        return "SOURCE"
    if old.bound is None or new.bound is None or not is_better(new.bound, old.bound, old.direction):
        return "LOOSENED"
    return None


def cmd_tightens(args: argparse.Namespace) -> int:
    """Exit 0 when the head bounds differ from the base's only by tightened bound values (at
    least one, _not_a_tightening); else print each other difference and exit 1."""
    base = load_bounds(Path(args.base_bounds))
    head = load_bounds(Path(args.head_bounds))
    changed = [m for m in sorted(set(base) | set(head)) if base.get(m) != head.get(m)]
    others = [(m, why) for m in changed if (why := _not_a_tightening(m, base.get(m), head.get(m)))]
    for metric, why in others:
        print(f"ratchet-bound {metric} {why}")
    return EXIT_OK if changed and not others else EXIT_RATCHET


# ---- merge-driver: git's three-way merge of the committed metrics files ----------------------
# Why (2026-10-20): docs/metrics/ratchet.json, report-only.json and scorecard.json are whole-file
# JSON that every lane's tighten rewrites, and sorted keys put two lanes' edits on neighbouring
# lines, so parallel lanes conflicted on rebase (4 of the fleet's 40 non-green gates in 30 days).
# The driver merges key by key: a key one side changed takes that side, a key both changed to
# the same value takes it, and a key both changed differently takes the STRICTER bound (the
# direction's better one; never a silent loosening; the gate then measures the merged tree).
# GOTCHA: that stricter value is one nobody measured on the merged tree (kitchen #25: base 1,
# main's labelled rebaseline 7, the PR's own tighten 0 -> 0, and the merged tree measured 1), so
# the driver prints one `ratchet merge:` line per bound it settled, and check names the cause
# when such a bound reads WORSE.
# Installed by hooks_check.sh --fix (the .gitattributes lines and the per-clone driver config);
# git runs it from the worktree's top level as `merge-driver %O %A %B %P` and reads the result
# from %A. Exit 1 is a conflict git reports: it leaves %A as ours, and the configured fallback
# (`|| git merge-file`) then makes the ordinary text merge.
_ABSENT = object()  # a key one side deleted


class MergeConflict(Exception):
    """Two sides changed one key in ways the driver will not choose between."""


def _stricter_bound(key: str, base: object, ours: object, theirs: object) -> object:
    """ratchet.json: both sides moved one bound. The tighter one wins; null (not yet seeded)
    loses to a number; a deletion or a direction change is a conflict. Prints one `ratchet
    merge:` line naming the three values (git shows a driver's stderr), because the winner was
    measured on neither side's tree merged with the other."""
    if ours is _ABSENT or theirs is _ABSENT:
        raise MergeConflict(f"{key}: deleted on one side, changed on the other")
    a, b = parse_bounds({key: ours}, "ours")[key], parse_bounds({key: theirs}, "theirs")[key]
    if a.direction != b.direction:
        raise MergeConflict(f"{key}: direction {a.direction} on one side, {b.direction} on the other")
    if a.bound is None or b.bound is None:
        return theirs if a.bound is None else ours
    won = theirs if is_better(b.bound, a.bound, a.direction) else ours
    was = parse_bounds({key: base}, "base")[key].bound if isinstance(base, dict) else None
    kept = b.bound if won is theirs else a.bound
    print(
        f"ratchet merge: {key} base {_fmt(was)}, one side {_fmt(a.bound)}, the other "
        f"{_fmt(b.bound)} -> {_fmt(kept)} (the stricter; measured on neither tree merged: run "
        "make ci-metrics before push, and make metrics-rebaseline KEYS=<key> if it is WORSE)",
        file=sys.stderr,
    )
    return won


def _wired_wins(key: str, _base: object, ours: object, theirs: object) -> object:
    """scorecard.json: both sides changed one check's entry; wired on either side stays wired
    (an unwired record beats a deletion). Of two share-only files' shares, the higher wins."""
    sides = (ours, theirs)
    if all(v is _ABSENT or isinstance(v, bool) for v in sides):
        return any(v is True for v in sides)
    shares = [v for v in sides if isinstance(v, (int, float)) and not isinstance(v, bool)]
    if len(shares) == 2:
        return max(shares)
    raise MergeConflict(f"{key}: changed on both sides and not a check entry or share on both")


def _ours(key: str, _base: object, ours: object, theirs: object) -> object:
    """report-only.json: observations, not bounds; the next tighten rewrites them anyway."""
    return theirs if ours is _ABSENT else ours


# The three committed files by name: how a key both sides changed is settled, and whether the
# file's nested objects (report-only's metrics and sources) merge per key or as one value.
_MERGE_RULES: dict[str, tuple[Callable[[str, object, object, object], object], bool]] = {
    "ratchet.json": (_stricter_bound, False),
    "scorecard.json": (_wired_wins, True),
    "report-only.json": (_ours, True),
}


def merge_json(
    base: object, ours: object, theirs: object,
    both: Callable[[str, object, object, object], object],
    *, nested: bool, path: str = "",
) -> object:
    """Per-key three-way merge of two JSON objects against their base."""
    if not (isinstance(ours, dict) and isinstance(theirs, dict) and isinstance(base, dict)):
        raise MergeConflict(f"{path or 'the file'}: not a JSON object on every side")
    out: dict[str, object] = {}
    for key in sorted(set(base) | set(ours) | set(theirs)):
        b, o, t = base.get(key, _ABSENT), ours.get(key, _ABSENT), theirs.get(key, _ABSENT)
        name = f"{path}.{key}" if path else key
        if o == t or t == b:
            value = o
        elif o == b:
            value = t
        elif nested and all(isinstance(x, dict) for x in (o, t)):
            value = merge_json(b if isinstance(b, dict) else {}, o, t, both, nested=True, path=name)
        else:
            value = both(name, b, o, t)
        if value is not _ABSENT:
            out[key] = value
    return out


def cmd_merge_driver(args: argparse.Namespace) -> int:
    name = Path(args.path).name
    rule = _MERGE_RULES.get(name)
    if rule is None:
        print(f"ratchet merge-driver: {args.path} is not one of {', '.join(_MERGE_RULES)}", file=sys.stderr)
        return EXIT_RATCHET
    both, nested = rule
    try:
        # A file both sides added has an empty base.
        docs = [_parse_json(Path(f).read_text(encoding="utf-8").strip() or "{}", f) for f in (args.base, args.ours, args.theirs)]
        merged = merge_json(*docs, both, nested=nested)
    except (InputError, MergeConflict, OSError) as exc:
        print(f"ratchet merge-driver: {args.path}: {exc}; leaving it to git's text merge", file=sys.stderr)
        return EXIT_RATCHET
    _atomic_write(Path(args.ours), json.dumps(merged, indent=2, sort_keys=True) + "\n")
    return EXIT_OK


def _add_sync_parsers(sub: argparse._SubParsersAction) -> None:
    """The devkit sync's bounds check (module docstring, A devkit sync's bounds)."""
    tightens = sub.add_parser(
        "tightens",
        help="exit 0 when the head bounds only tighten the base's (a devkit sync's test)",
    )
    tightens.add_argument("--base-bounds", required=True, help="the base's bounds JSON")
    tightens.add_argument("--head-bounds", required=True, help="the head's bounds JSON")
    tightens.set_defaults(func=cmd_tightens)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="metrics_ratchet.py",
        description="Hold codebase metrics to committed bounds that only move the good way.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    check = sub.add_parser(
        "check", help="print a snapshot against the bounds (report only: always exit 0)"
    )
    check.add_argument("--snapshot", required=True, help="metrics snapshot JSON")
    check.add_argument("--bounds", required=True, help="bounds JSON (docs/metrics/ratchet.json)")
    check.add_argument(
        "--show-untracked",
        action="store_true",
        help="list each untracked metric, not just the count",
    )
    check.set_defaults(func=cmd_check)

    tighten = sub.add_parser(
        "tighten", help="move each bound the snapshot beats to the snapshot value (never loosens)"
    )
    tighten.add_argument("--snapshot", required=True, help="metrics snapshot JSON")
    tighten.add_argument("--bounds", required=True, help="bounds JSON to rewrite")
    tighten.add_argument("--report-only", metavar="FILE", help=REPORT_ONLY_HELP)
    tighten.add_argument(
        "--seed",
        action="store_true",
        help="also add a bound at today's value for every snapshot key without one (the "
        "direction from its domain; floors are seeded without it); never seeds gate, tier or "
        "report-only keys",
    )
    tighten.set_defaults(func=cmd_tighten)

    rebaseline = sub.add_parser(
        "rebaseline", help="overwrite every tracked bound with the snapshot value"
    )
    rebaseline.add_argument("--snapshot", required=True, help="metrics snapshot JSON")
    rebaseline.add_argument("--bounds", required=True, help="bounds JSON to rewrite")
    rebaseline.add_argument("--report-only", metavar="FILE", help=REPORT_ONLY_HELP)
    rebaseline.add_argument(
        "--keys",
        metavar="K1,K2",
        help="loosen only these bounds, each only when the snapshot is worse; no other bound "
        "moves, nothing is seeded or dropped",
    )
    rebaseline.set_defaults(func=cmd_rebaseline)

    _add_sync_parsers(sub)

    floors = sub.add_parser(
        "floors", help="print `<tier> <runner> <min>` per test-count floor (tier_guard.sh)"
    )
    floors.add_argument("--bounds", required=True, help="bounds JSON (docs/metrics/ratchet.json)")
    floors.add_argument("--tier", help="only this tier's floors")
    floors.set_defaults(func=cmd_floors)

    merge = sub.add_parser("merge", help="merge collector outputs into one snapshot envelope")
    merge.add_argument("--out", required=True, help="snapshot JSON to write")
    merge.add_argument(
        "--skipped",
        action="append",
        default=[],
        metavar="NAME",
        help="a collector that did not run (its tracked keys are SKIPPED, not MISSING, in "
        "check); repeatable",
    )
    merge.add_argument(
        "inputs", nargs="*", help="collector JSON files (build/metrics/*.json); none is valid"
    )
    merge.set_defaults(func=cmd_merge)

    driver = sub.add_parser(
        "merge-driver",
        help="git's merge driver for docs/metrics/{ratchet,report-only,scorecard}.json: per key, "
        "the stricter bound where both sides moved one (hooks_check.sh --fix installs it)",
    )
    driver.add_argument("base", help="%%O: the merge base's version")
    driver.add_argument("ours", help="%%A: ours, rewritten with the result")
    driver.add_argument("theirs", help="%%B: theirs")
    driver.add_argument("path", help="%%P: the path in the tree, which names the file's rules")
    driver.set_defaults(func=cmd_merge_driver)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except InputError as exc:
        print(f"ratchet ERROR: {exc}", file=sys.stderr)
        return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
