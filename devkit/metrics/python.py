#!/usr/bin/env python3
"""Shared Python metrics collector: McCabe and cognitive complexity, dead code, import cycles.

One line in scripts/ci/metrics.conf, run by devkit/bin/metrics_collect.sh, for example:
  py-backend backend uv run --frozen --project backend python devkit/metrics/python.py \\
      --root backend --src server --scope backend --mccabe --cognitive --vulture --cycles \\
      --out build/metrics/py-backend.json

Why the repo's own interpreter: ruff, complexipy and vulture are the repo's dev dependencies,
installed in its virtualenv. `python devkit/metrics/python.py` under `uv run` makes that
interpreter `sys.executable`, and every tool is reached through it (`<python> -m ruff`,
`<python> -m vulture`, the `complexipy` entry point beside it), so the versions the lockfile
pins are the versions that measure. `--python` names another interpreter when the collector
itself must run elsewhere. A requested tool that is not installed is exit 2 naming the dev
dependency to add; nothing is silently skipped.

Keys (docs/metrics-keys.md), each behind its flag; `<scope>` is `--scope`:
  --mccabe     complexity.<scope>.mccabe_max        ruff C901 at max-complexity 0, --ignore-noqa
               complexity.<scope>.mccabe_over_10    functions above McCabe 10
  --cognitive  complexity.<scope>.cognitive_max     complexipy
               complexity.<scope>.cognitive_over_15 functions above 15 (SonarSource's threshold)
  --vulture    dead.<scope>.vulture                 findings, honouring [tool.vulture] in
                                                    <root>/pyproject.toml (paths, min_confidence,
                                                    ignore_names); without it, the --src paths
  --cycles     coupling.<scope>.cycles              import cycles among the --src modules:
                                                    strongly connected components of the runtime
                                                    import graph (`if TYPE_CHECKING:` excluded,
                                                    imports inside functions included) with more
                                                    than one module, or a self-import

Deterministic: the same tree gives the same numbers (sorted inputs, no timings, no paths in
the output). Output: a flat JSON object to --out (default stdout). Exit: 0 ok, 2 a missing
tool, an unparseable tool report or a bad call.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
from collections.abc import Iterable
from pathlib import Path

EXIT_USAGE = 2
MCCABE_THRESHOLD = 10
COGNITIVE_THRESHOLD = 15
SCOPE = re.compile(r"[A-Za-z0-9_-]+")  # the key's middle segment: no dots, no whitespace
# ruff's C901 message carries the number; the threshold is 0 so every function is reported.
RUFF_C901 = re.compile(r"^`(?P<name>.+)` is too complex \((?P<cx>\d+) > 0\)$")
VULTURE_LINE = re.compile(r"^(?P<file>.+?):(?P<line>\d+): unused (?P<kind>[a-z]+) '")
VULTURE_FINDINGS_EXIT = 3  # vulture's "I reported something", not a failure


class CollectorError(Exception):
    """A missing tool, a report that cannot be read or a bad invocation (exit 2)."""


def run_tool(cmd: list[str], *, cwd: Path, ok: Iterable[int] = (0, 1)) -> str:
    """Run a tool and return stdout. Linters exit 1 when they report findings, which is the
    point here, so 0 and 1 (or the tool's own `ok` codes) are results; anything else fails."""
    try:
        proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=False)
    except OSError as exc:
        raise CollectorError(f"cannot run {cmd[0]}: {exc.strerror}") from exc
    if proc.returncode not in ok:
        raise CollectorError(
            f"{' '.join(cmd[:4])} ... exited {proc.returncode}\n{proc.stderr[-2000:]}"
        )
    return proc.stdout


def require_module(python: str, module: str, dependency: str, cwd: Path) -> None:
    """Exit 2 naming the dev dependency when `<python> -m <module>` cannot start."""
    probe = subprocess.run(
        [python, "-c", f"import {module}"], cwd=cwd, capture_output=True, text=True, check=False
    )
    if probe.returncode != 0:
        raise CollectorError(
            f"{dependency} is not importable under {python}; add it to the dev dependencies "
            f"(the collector runs under the repo's own interpreter: `uv run ... python "
            f"devkit/metrics/python.py`)"
        )


def _parse_json(text: str, what: str) -> object:
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise CollectorError(f"{what} is not valid JSON: {exc}") from exc


# ------------------------------------------------------------------------------ McCabe


def collect_mccabe(python: str, root: Path, src: list[str], scope: str) -> dict[str, int]:
    require_module(python, "ruff", "ruff", root)
    out = run_tool(
        [
            python, "-m", "ruff", "check", *src,
            "--select", "C901",
            "--config", "lint.mccabe.max-complexity = 0",
            "--ignore-noqa", "--no-cache", "--output-format", "json",
        ],
        cwd=root,
    )  # fmt: skip
    values = []
    for item in _parse_json(out, "ruff output"):
        match = RUFF_C901.match(item["message"])
        if match is None:
            raise CollectorError(f"unparseable ruff C901 message: {item['message']!r}")
        values.append(int(match["cx"]))
    return {
        f"complexity.{scope}.mccabe_max": max(values, default=0),
        f"complexity.{scope}.mccabe_over_{MCCABE_THRESHOLD}": sum(
            1 for v in values if v > MCCABE_THRESHOLD
        ),
    }


# --------------------------------------------------------------------------- cognitive


def collect_cognitive(python: str, root: Path, src: list[str], scope: str) -> dict[str, int]:
    # complexipy ships a console script, not a runnable module; it sits beside the interpreter
    # (`.venv/bin/complexipy`). Not resolve(): a venv's python is a symlink to the base
    # interpreter, whose bin/ holds no project tools.
    exe = Path(shutil.which(python) or python)
    complexipy = exe.parent / "complexipy"
    if not complexipy.exists():
        raise CollectorError(
            f"complexipy is not installed beside {python} (expected {complexipy}); add "
            "complexipy to the dev dependencies"
        )
    with tempfile.TemporaryDirectory(prefix="devkit-metrics-") as tmp:
        report = Path(tmp) / "complexipy.json"
        run_tool(
            [
                str(complexipy), *src,
                "--max-complexity-allowed", "0", "--output-format", "json",
                "--output", str(report), "--quiet", "--no-ignore", "--cache-dir", tmp,
            ],
            cwd=root,
        )  # fmt: skip
        if not report.exists():
            raise CollectorError("complexipy wrote no JSON report")
        entries = _parse_json(report.read_text(encoding="utf-8"), "complexipy report")
    values = [int(e["complexity"]) for e in entries]
    return {
        f"complexity.{scope}.cognitive_max": max(values, default=0),
        f"complexity.{scope}.cognitive_over_{COGNITIVE_THRESHOLD}": sum(
            1 for v in values if v > COGNITIVE_THRESHOLD
        ),
    }


# ----------------------------------------------------------------------------- vulture


def _vulture_configured(root: Path) -> bool:
    pyproject = root / "pyproject.toml"
    if not pyproject.exists():
        return False
    try:
        doc = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        raise CollectorError(f"{pyproject} is not valid TOML: {exc}") from exc
    return "paths" in doc.get("tool", {}).get("vulture", {})


def collect_vulture(python: str, root: Path, src: list[str], scope: str) -> dict[str, int]:
    require_module(python, "vulture", "vulture", root)
    # With [tool.vulture] paths in pyproject.toml, vulture reads its own configuration (paths,
    # whitelist, min_confidence); passing paths would override that. Without it, the --src paths.
    args = [] if _vulture_configured(root) else src
    out = run_tool([python, "-m", "vulture", *args], cwd=root, ok=(0, VULTURE_FINDINGS_EXIT))
    count = 0
    for line in out.splitlines():
        if not line.strip():
            continue
        if VULTURE_LINE.match(line) is None:
            raise CollectorError(f"unparseable vulture line: {line!r}")
        count += 1
    return {f"dead.{scope}.vulture": count}


# ------------------------------------------------------------------------------ cycles
# Lifted from finplat scripts/metrics/coupling.py (backend graph), unchanged in substance.

Graph = dict[str, set[str]]


def module_name(rel: Path) -> str:
    """`server/services/x.py` -> `server.services.x`; a package's `__init__.py` is the package."""
    parts = rel.with_suffix("").parts
    return ".".join(parts[:-1] if parts[-1] == "__init__" else parts)


def _is_type_checking(test: ast.expr) -> bool:
    return (isinstance(test, ast.Name) and test.id == "TYPE_CHECKING") or (
        isinstance(test, ast.Attribute) and test.attr == "TYPE_CHECKING"
    )


def _runtime_nodes(tree: ast.AST) -> list[ast.Import | ast.ImportFrom]:
    """Import statements that execute: the `if TYPE_CHECKING:` body is skipped."""
    found: list[ast.Import | ast.ImportFrom] = []

    def visit(node: ast.AST) -> None:
        if isinstance(node, ast.Import | ast.ImportFrom):
            found.append(node)
        if isinstance(node, ast.If) and _is_type_checking(node.test):
            for child in node.orelse:
                visit(child)
            return
        for child in ast.iter_child_nodes(node):
            visit(child)

    visit(tree)
    return found


def _longest_known(dotted: str, known: set[str]) -> str | None:
    """`a.b.c.name` -> the deepest prefix that is a module of ours."""
    parts = dotted.split(".")
    for size in range(len(parts), 0, -1):
        candidate = ".".join(parts[:size])
        if candidate in known:
            return candidate
    return None


def imports_of(tree: ast.AST, module: str, is_package: bool, known: set[str]) -> set[str]:
    """Modules of ours that `module` imports at runtime."""
    targets: set[str] = set()
    package = module if is_package else module.rpartition(".")[0]
    for node in _runtime_nodes(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                hit = _longest_known(alias.name, known)
                if hit:
                    targets.add(hit)
            continue
        if node.level:
            anchor = package.rsplit(".", node.level - 1)[0] if node.level > 1 else package
            base = f"{anchor}.{node.module}" if node.module else anchor
        else:
            base = node.module or ""
        # `from pkg import name`: a submodule is an edge to that submodule only; the package
        # itself (its __init__) is an edge when a name is read from it. A submodule import
        # also runs the parent package first, but that parent is already loading (or loaded)
        # by then, so counting it would turn every re-exporting package into a false cycle.
        from_base = False
        for alias in node.names:
            sub = f"{base}.{alias.name}"
            if sub in known:
                targets.add(sub)
            else:
                from_base = True
        base_hit = _longest_known(base, known)
        if base_hit and (from_base or not node.names):
            targets.add(base_hit)
    targets.discard(module)
    return targets


def source_files(root: Path, src: list[str]) -> list[Path]:
    """Every `*.py` the --src entries name, relative to --root: a directory's tree, a module
    file as itself (a flat backend's app.py, config.py beside its packages)."""
    found: set[Path] = set()
    for entry in src:
        path = root / entry
        found.update(path.rglob("*.py") if path.is_dir() else [path])
    return sorted(p.relative_to(root) for p in found)


def import_graph(root: Path, src: list[str]) -> Graph:
    """Module -> modules it imports at runtime, over every `*.py` the --src entries name."""
    files = source_files(root, src)
    known = {module_name(rel) for rel in files}
    graph: Graph = {}
    for rel in files:
        try:
            tree = ast.parse((root / rel).read_text(encoding="utf-8"), filename=str(rel))
        except (SyntaxError, UnicodeDecodeError) as exc:
            raise CollectorError(f"cannot parse {rel}: {exc}") from exc
        name = module_name(rel)
        graph[name] = imports_of(tree, name, rel.name == "__init__.py", known)
    return graph


def strongly_connected(graph: Graph) -> list[list[str]]:
    """Tarjan's algorithm, iterative (a deep import chain must not hit the recursion limit).
    Returns every component with more than one module, or a module importing itself."""
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    on_stack: set[str] = set()
    stack: list[str] = []
    components: list[list[str]] = []
    counter = 0
    for root in sorted(graph):
        if root in index:
            continue
        work = [(root, iter(sorted(graph[root])))]
        index[root] = low[root] = counter
        counter += 1
        stack.append(root)
        on_stack.add(root)
        while work:
            node, children = work[-1]
            advanced = False
            for child in children:
                if child not in index:
                    index[child] = low[child] = counter
                    counter += 1
                    stack.append(child)
                    on_stack.add(child)
                    work.append((child, iter(sorted(graph.get(child, ())))))
                    advanced = True
                    break
                if child in on_stack:
                    low[node] = min(low[node], index[child])
            if advanced:
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
            if low[node] == index[node]:
                component = []
                while True:
                    member = stack.pop()
                    on_stack.discard(member)
                    component.append(member)
                    if member == node:
                        break
                if len(component) > 1 or node in graph.get(node, ()):
                    components.append(sorted(component))
    return components


def collect_cycles(root: Path, src: list[str], scope: str) -> dict[str, int]:
    return {f"coupling.{scope}.cycles": len(strongly_connected(import_graph(root, src)))}


# --------------------------------------------------------------------------------- cli


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python.py", description="Python complexity, dead-code and import-cycle metrics."
    )
    parser.add_argument("--root", required=True, help="the Python project (holds pyproject.toml)")
    parser.add_argument(
        "--src",
        required=True,
        nargs="+",
        metavar="PATH",
        help="source dirs or .py modules under --root",
    )
    parser.add_argument("--scope", required=True, help="the key's middle segment (backend, ...)")
    parser.add_argument("--out", help="write the JSON here (default: stdout)")
    parser.add_argument(
        "--python",
        default=sys.executable,
        help="interpreter whose ruff, complexipy and vulture to use (default: this one)",
    )
    parser.add_argument("--mccabe", action="store_true", help="ruff C901")
    parser.add_argument("--cognitive", action="store_true", help="complexipy")
    parser.add_argument("--vulture", action="store_true", help="vulture findings")
    parser.add_argument("--cycles", action="store_true", help="AST import cycles")
    return parser


def collect(args: argparse.Namespace) -> dict[str, int]:
    root = Path(args.root)
    if not root.is_dir():
        raise CollectorError(f"--root {root} is not a directory")
    for entry in args.src:
        path = root / entry
        if not (path.is_dir() or (path.is_file() and path.suffix == ".py")):
            raise CollectorError(f"--src {entry} is not a directory or .py module under {root}")
    if SCOPE.fullmatch(args.scope) is None:
        raise CollectorError(f"--scope {args.scope!r} must match [A-Za-z0-9_-]+")
    if not (args.mccabe or args.cognitive or args.vulture or args.cycles):
        raise CollectorError(
            "nothing to collect: pass --mccabe, --cognitive, --vulture or --cycles"
        )
    out: dict[str, int] = {}
    if args.mccabe:
        out.update(collect_mccabe(args.python, root, args.src, args.scope))
    if args.cognitive:
        out.update(collect_cognitive(args.python, root, args.src, args.scope))
    if args.vulture:
        out.update(collect_vulture(args.python, root, args.src, args.scope))
    if args.cycles:
        out.update(collect_cycles(root, args.src, args.scope))
    return out


def write_output(doc: dict[str, int], out: str | None) -> None:
    text = json.dumps(doc, indent=2, sort_keys=True) + "\n"
    if out is None:
        sys.stdout.write(text)
        return
    path = Path(out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        write_output(collect(args), args.out)
    except CollectorError as exc:
        print(f"metrics/python.py: {exc}", file=sys.stderr)
        return EXIT_USAGE
    return 0


if __name__ == "__main__":
    sys.exit(main())
