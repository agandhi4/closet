// Shared by ts.mjs and jscpd.mjs: the tool runner, the exit-2 path, output writing, glob
// matching and the cycle count. Node stdlib only; runs on a consumer's pinned Node (.nvmrc).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const EXIT_USAGE = 2;
export const SCOPE = /^[A-Za-z0-9_-]+$/;

export class CollectorError extends Error {}

// fail: the one exit-2 path, so every "cannot measure" reason prints the same way.
export function fail(script, message) {
  process.stderr.write(`metrics/${script}: ${message}\n`);
  process.exit(EXIT_USAGE);
}

// requireBin: the tool from the project's own node_modules/.bin (absolute, since the tool
// then runs with --root as its cwd), or exit 2 naming the dev dependency to add. Tools are
// never taken from PATH: the lockfile's version measures.
export function requireBin(root, name, dependency) {
  const bin = resolve(root, "node_modules", ".bin", name);
  if (!existsSync(bin)) {
    throw new CollectorError(
      `${name} is not installed in ${root}/node_modules/.bin; add ${dependency} to the dev dependencies and run the install`,
    );
  }
  return bin;
}

// runTool: stdout of a tool. Linters exit 1 when they report findings, which is the point,
// so 0 and 1 (or the given codes) are results; anything else is the tool failing.
export function runTool(bin, args, { cwd, env, ok = [0, 1] } = {}) {
  const proc = spawnSync(bin, args, {
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (proc.error) throw new CollectorError(`cannot run ${bin}: ${proc.error.message}`);
  if (!ok.includes(proc.status)) {
    throw new CollectorError(
      `${bin} ${args.slice(0, 3).join(" ")} ... exited ${proc.status}\n${(proc.stderr ?? "").slice(-2000)}`,
    );
  }
  return proc.stdout;
}

export function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CollectorError(`${what} is not valid JSON: ${err.message}`);
  }
}

// writeOutput: sorted keys, two-space indent, trailing newline: the same bytes as the Python
// collectors, so a diff of build/metrics/ shows numbers, not formatting.
export function writeOutput(doc, out) {
  const sorted = Object.fromEntries(Object.entries(doc).sort(([a], [b]) => (a < b ? -1 : 1)));
  const text = `${JSON.stringify(sorted, null, 2)}\n`;
  if (out === undefined) {
    process.stdout.write(text);
    return;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
}

// globToRegExp: a path glob over a posix path relative to the source root. `**` crosses
// directories, `*` and `?` stay within one, `{a,b}` alternates. Anchored at both ends; a
// pattern without `/` matches at any depth (`*.test.ts` means `**/*.test.ts`).
export function globToRegExp(glob) {
  const pattern = glob.includes("/") ? glob : `**/${glob}`;
  let re = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more directories; a trailing `**` matches the rest.
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") re += "[^/]";
    else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) throw new CollectorError(`glob ${glob}: unclosed {`);
      re += `(?:${pattern.slice(i + 1, end).split(",").map(escapeRegExp).join("|")})`;
      i = end;
    } else re += escapeRegExp(ch);
  }
  return new RegExp(`^${re}$`);
}

function escapeRegExp(text) {
  return text.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

// stronglyConnected: Tarjan, iterative. `graph` is Map<module, Set<module>> with every edge
// pointing at a key. Returns the components with more than one module, or a self-import.
export function stronglyConnected(graph) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;
  for (const root of [...graph.keys()].sort()) {
    if (index.has(root)) continue;
    const work = [[root, [...graph.get(root)].sort()[Symbol.iterator]()]];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const [node, children] = work[work.length - 1];
      let advanced = false;
      for (const child of children) {
        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          work.push([child, [...(graph.get(child) ?? [])].sort()[Symbol.iterator]()]);
          advanced = true;
          break;
        }
        if (onStack.has(child)) low.set(node, Math.min(low.get(node), index.get(child)));
      }
      if (advanced) continue;
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
      if (low.get(node) === index.get(node)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== node);
        if (component.length > 1 || graph.get(node)?.has(node)) components.push(component.sort());
      }
    }
  }
  return components;
}
