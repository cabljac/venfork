import { isBuiltin } from 'node:module';
import path from 'node:path';

/** A Node version as `[major, minor, patch]`. */
export type NodeVersion = [number, number, number];

const COMPARATOR =
  /^(>=|>|\^|~|=)?\s*v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/;

function part(value: string | undefined): number {
  return value === undefined || value === 'x' || value === '*'
    ? 0
    : Number(value);
}

/**
 * The lowest version an `engines.node` range admits, or null when the range
 * cannot be read. An alternative that only caps (`<20`) admits 0.0.0.
 */
export function nodeRangeFloor(range: string): NodeVersion | null {
  let floor: NodeVersion | null = null;
  for (const alternative of range.split('||')) {
    const text = alternative.trim();
    let version: NodeVersion;
    if (text === '' || text === '*' || text.startsWith('<')) {
      version = [0, 0, 0];
    } else {
      const m = COMPARATOR.exec(text);
      if (!m) return null;
      version = [part(m[2]), part(m[3]), part(m[4])];
    }
    if (floor === null || compareVersions(version, floor) < 0) floor = version;
  }
  return floor;
}

function compareVersions(a: NodeVersion, b: NodeVersion): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** One installed package and its `engines.node` range. */
export interface PackageEngines {
  name: string;
  range: string;
}

/**
 * Lists `name (range)` for each dependency whose `engines.node` floor is
 * above the floor of `own`, so venfork never claims a Node its libraries
 * refuse.
 */
export function enginesFloorShortfall(
  own: string,
  deps: readonly PackageEngines[]
): string[] {
  const ownFloor = nodeRangeFloor(own);
  if (ownFloor === null) return [`venfork (${own})`];
  return deps
    .filter((dep) => {
      const floor = nodeRangeFloor(dep.range);
      return floor === null || compareVersions(floor, ownFloor) > 0;
    })
    .map((dep) => `${dep.name} (${dep.range})`);
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

async function findPackageDir(
  name: string,
  from: string,
  root: string
): Promise<string | null> {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (await Bun.file(path.join(candidate, 'package.json')).exists()) {
      return candidate;
    }
    if (dir === root || dir === path.dirname(dir)) return null;
  }
}

/**
 * The `engines.node` range of every installed package the CLI runs with:
 * each package `src/` imports, and their dependencies, transitively.
 * Packages with no `engines.node` are left out. Reads with `Bun.file`, so a
 * test's `node:fs` mock cannot answer for the real tree.
 */
export async function runtimeDependencyEngines(
  root: string
): Promise<PackageEngines[]> {
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  const roots = new Set<string>();
  const files = new Bun.Glob('**/*.ts').scan(path.join(root, 'src'));
  for await (const file of files) {
    const source = await Bun.file(path.join(root, 'src', file)).text();
    for (const { path: specifier } of transpiler.scanImports(
      source.replace(/^#!.*/, '')
    )) {
      if (!specifier.startsWith('.') && !isBuiltin(specifier)) {
        roots.add(packageName(specifier));
      }
    }
  }
  const found: PackageEngines[] = [];
  const seen = new Set<string>();
  const queue = [...roots].map((name) => ({ name, from: root }));
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const dir = await findPackageDir(next.name, next.from, root);
    if (dir === null) throw new Error(`${next.name} is not installed`);
    if (seen.has(dir)) continue;
    seen.add(dir);
    const pkg = (await Bun.file(path.join(dir, 'package.json')).json()) as {
      engines?: { node?: string };
      dependencies?: Record<string, string>;
    };
    if (pkg.engines?.node) {
      found.push({ name: next.name, range: pkg.engines.node });
    }
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      queue.push({ name: dep, from: dir });
    }
  }
  return found;
}

/** Doctor check ids, in order, for a healthy fixture with a failing `gh` stub. */
export const EXPECTED_DOCTOR_IDS = [
  'repo',
  'remotes',
  'mode',
  'invariant',
  'divergence',
  'preserve',
  'workflow',
  'transport',
  'token',
  'last-run',
  'cron-age',
];

/** Checks that are `'skipped'` on the fixture, whose origin is a local path. */
export const SKIPPED_DOCTOR_IDS = ['transport'];

/**
 * Validates `doctor --json` output from the smoke run. Returns a problem
 * description, or null when the exit code, envelope, ids and results are
 * as expected: every check `true`, except {@link SKIPPED_DOCTOR_IDS}.
 */
export function verifyDoctorOutput(
  exitCode: number | undefined,
  stdout: string
): string | null {
  let envelope: {
    schemaVersion?: unknown;
    ok?: unknown;
    result?: { checks?: Array<{ id?: string; ok?: unknown }> };
  };
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return `doctor --json did not print JSON:\n${stdout}`;
  }
  if (exitCode !== 0) return `doctor exited with exit code ${exitCode}`;
  if (envelope?.schemaVersion !== 1 || envelope.ok !== true) {
    return `doctor --json did not print a schemaVersion 1 success envelope: ${stdout}`;
  }
  const checks = envelope.result?.checks;
  if (!Array.isArray(checks))
    return `doctor output has no result.checks array: ${stdout}`;
  const ids = checks.map((c) => c.id);
  if (JSON.stringify(ids) !== JSON.stringify(EXPECTED_DOCTOR_IDS)) {
    return `unexpected check ids: ${ids.join(',')}; want ${EXPECTED_DOCTOR_IDS.join(',')}`;
  }
  const failed = checks
    .filter(
      (c) =>
        c.ok !== (SKIPPED_DOCTOR_IDS.includes(c.id ?? '') ? 'skipped' : true)
    )
    .map((c) => c.id);
  if (failed.length > 0) return `failing checks: ${failed.join(',')}`;
  return null;
}

const REQUIRE_CALL = /\b(?:__)?require\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Lists the distinct module specifiers in a bundle that are not Node
 * builtins: ESM imports and `require` calls, the bundler's `__require` too.
 * An empty list means the bundle runs with no installed dependencies.
 */
export function nonBuiltinImports(bundle: string): string[] {
  const code = bundle.replace(/^#!.*/, '');
  const specifiers = [
    ...new Bun.Transpiler({ loader: 'js' })
      .scanImports(code)
      .map((i) => i.path),
    ...[...code.matchAll(REQUIRE_CALL)].map((m) => m[1]),
  ];
  return [...new Set(specifiers)].filter((s) => !isBuiltin(s)).sort();
}
