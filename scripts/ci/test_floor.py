#!/usr/bin/env python3
"""Collected-count floor for a test tier: fails when a run executed fewer tests than the floor.

A suite that silently loses files (a glob edit, a moved directory, an `include` typo) still
passes green; the floor catches it. Raise the floor when tests are added, lower it only in the
PR that removes tests, with the reason (docs/decisions.md, Lean test suite, 2026-10-13).

Usage: test_floor.py <report.json> <floor>
  Vitest `--reporter=json` (numTotalTests, numPendingTests: skipped tests do not count) or
  Playwright `--reporter=json` (stats.expected + stats.unexpected + stats.flaky: skipped do not).
Prints `floor <file>: <ran> tests (floor <n>)` and exits 1 below the floor, 2 on a bad file.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def ran_tests(report: dict) -> int:
    if "numTotalTests" in report:  # Vitest
        return int(report["numTotalTests"]) - int(report.get("numPendingTests", 0))
    stats = report.get("stats")  # Playwright
    if isinstance(stats, dict) and "expected" in stats:
        return int(stats["expected"]) + int(stats.get("unexpected", 0)) + int(stats.get("flaky", 0))
    raise ValueError("neither a Vitest nor a Playwright JSON report")


def main(argv: list[str]) -> int:
    if len(argv) != 3 or not argv[2].isdigit():
        print(__doc__, file=sys.stderr)
        return 2
    path, floor = Path(argv[1]), int(argv[2])
    try:
        ran = ran_tests(json.loads(path.read_text()))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"floor {path}: unreadable report ({error})", file=sys.stderr)
        return 2
    print(f"floor {path}: {ran} tests (floor {floor})")
    return 0 if ran >= floor else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
