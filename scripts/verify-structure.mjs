import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, extname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_SUFFIXES = new Set(['.py', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const IMPORT_SUFFIXES = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.json'];

const read = (rel) => fs.readFile(join(ROOT, rel), 'utf8');
const write = (rel, text) => fs.writeFile(join(ROOT, rel), text);
const gitLines = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean);
const OWN_PATHS = new Set(['scripts/verify-structure.mjs', 'test/architecture.test.mjs', 'test/docs.test.mjs']);
const isContractPath = (path) => (CONTRACT_SUFFIXES.has(path.slice(path.lastIndexOf('.'))) && !OWN_PATHS.has(path))
  || path === '.gitignore';
const isStableArchitecturePath = (path) => !path.startsWith('.spec/specs/') && !path.startsWith('.spec/archive/');

export function dependencyStrata(paths, edges) {
  const outgoing = new Map(paths.map((path) => [path, []]));
  for (const [from, to] of edges) outgoing.get(from)?.push(to);
  const depth = new Map();
  const visiting = new Set();
  const visit = (path) => {
    if (depth.has(path)) return depth.get(path);
    assert.ok(!visiting.has(path), `import graph cycle through ${path}`);
    visiting.add(path);
    const value = outgoing.get(path)?.length
      ? 1 + Math.max(...outgoing.get(path).map(visit))
      : 0;
    visiting.delete(path);
    depth.set(path, value);
    return value;
  };
  for (const path of paths) visit(path);
  const grouped = new Map();
  for (const path of paths) {
    const level = depth.get(path);
    if (!grouped.has(level)) grouped.set(level, []);
    grouped.get(level).push(path);
  }
  return new Map([...grouped].sort((left, right) => left[0] - right[0]));
}

export function assertAcyclic(nodes, edges) {
  const outgoing = new Map(nodes.map((node) => [node, []]));
  for (const [from, to] of edges) outgoing.get(from)?.push(to);
  const state = new Map();
  const walk = (node) => {
    const current = state.get(node) ?? 0;
    if (current === 1) throw new Error(`module DAG cycle through ${node}`);
    if (current === 2) return;
    state.set(node, 1);
    for (const next of outgoing.get(node) ?? []) walk(next);
    state.set(node, 2);
  };
  for (const node of nodes) walk(node);
}

function renderArchitecture(strata, modulePairs) {
  const name = (level) => `Dependency stratum ${level}`;
  const label = (level) => `Stratum${level}`;
  const maxLevel = Math.max(...strata.keys());
  const layers = [...strata.keys()].reverse().map((level) => `stratum-${level}`);
  const contracts = {
    version: 1,
    layers,
    modules: [...strata].map(([level, paths]) => ({
      name: name(level),
      layer: `stratum-${level}`,
      paths,
    })),
    forbid: [],
  };
  const index = ['# Structure governance', '',
    'Generated from Git-tracked paths and resolved direct imports by `scripts/verify-structure.mjs`.',
    'Stratum 0 has no outgoing imports; every higher stratum imports at least one lower stratum.',
    'This is a governance source, not a production runtime dependency. Historical `.spec/` records are frozen evidence.',
    ''];
  for (const [level, paths] of strata) {
    index.push(`## ${name(level)}`, '', 'Primary files:', ...paths.map((path) => `- \`${path}\``), '',
      `Files whose longest resolved import chain ends at stratum 0 in ${level} step(s).`, '');
  }
  const graph = ['flowchart TD'];
  for (const [level] of strata) graph.push(`  ${label(level)}[${name(level)}]`);
  for (const [from, to] of modulePairs) graph.push(`  ${label(from)} --> ${label(to)}`);
  const mmd = `${graph.join('\n')}\n`;
  const md = `# Module DAG\n\nGenerated from the same resolved direct imports as \`contracts.json\`.\nEdge direction is importer to imported module. The graph is acyclic; higher strata import lower strata.\n\n\`\`\`mermaid\n${mmd}\`\`\`\n`;
  return {
    'contracts.json': `${JSON.stringify(contracts, null, 2)}\n`,
    'module-index.md': `${index.join('\n').trimEnd()}\n`,
    'module-dag.mmd': mmd,
    'module-dag.md': md,
  };
}

function resolveImport(from, specifier, known) {
  if (!/^\.\.?\//.test(specifier)) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (known.has(base)) return base;
  for (const suffix of IMPORT_SUFFIXES) {
    if (known.has(base + suffix)) return base + suffix;
    const index = posix.join(base, `index${suffix}`);
    if (known.has(index)) return index;
  }
  return null;
}

async function collectImports() {
  const known = new Set(gitLines('ls-files', '-z').join('\n').split('\0').filter(Boolean));
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]|(?:^|\n)\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const edges = new Set();
  for (const from of known) {
    if (!CONTRACT_SUFFIXES.has(extname(from))) continue;
    const code = await fs.readFile(join(ROOT, from), 'utf8');
    for (const match of code.matchAll(pattern)) {
      const to = resolveImport(from, match[1] ?? match[2], known);
      if (to && to !== from) edges.add(`${from}\0${to}`);
    }
  }
  return [...edges].sort().map(edge => edge.split('\0'));
}

export async function verifyStructure({ regenerate = false } = {}) {
  const tracked = gitLines('ls-files', '-z').join('\n').split('\0').filter(Boolean);
  const declared = (await read('.spec/architecture/module-index.md'))
    .split('\n').map((line) => line.match(/^- \`([^`]+)\`$/)?.[1]).filter(Boolean);
  const allPaths = [...new Set([...tracked, ...declared])]
    .filter(isStableArchitecturePath)
    .sort();
  const paths = allPaths.filter(isContractPath);
  const importEdges = (await collectImports())
    .filter(([from, to]) => !OWN_PATHS.has(from) && !OWN_PATHS.has(to));
  const strata = dependencyStrata(paths, importEdges);
  const owner = new Map();
  for (const [level, members] of strata) for (const path of members) owner.set(path, level);
  const moduleEdgeKeys = new Set();
  for (const [from, to] of importEdges) {
    const source = owner.get(from);
    const target = owner.get(to);
    if (source !== undefined && target !== undefined && source !== target) moduleEdgeKeys.add(`${source}:${target}`);
  }
  const modulePairs = [...moduleEdgeKeys]
    .map((key) => key.split(':').map(Number))
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  assertAcyclic([...strata.keys()].map((level) => `Dependency stratum ${level}`),
    modulePairs.map(([from, to]) => [`Dependency stratum ${from}`, `Dependency stratum ${to}`]));
  for (const [from, to] of modulePairs) assert.ok(from > to, `stratum ${from} cannot import ${to}`);
  const files = renderArchitecture(strata, modulePairs);
  files['module-index.md'] = files['module-index.md'].replace(
    /## Dependency stratum 0\n\nPrimary files:\n([\s\S]*?)\n\nFiles whose longest/,
    (match, primary) => {
      const extra = allPaths.filter((path) => !isContractPath(path) && !primary.includes(`\`${path}\``));
      const lines = [...extra.map((path) => `- \`${path}\``)].join('\n');
      return `## Dependency stratum 0\n\nPrimary files:\n${primary}\n${lines}\n\nFiles whose longest`;
    },
  );
  for (const [rel, expected] of Object.entries(files)) {
    const actual = await read(`.spec/architecture/${rel}`);
    if (regenerate && actual !== expected) await write(`.spec/architecture/${rel}`, expected);
    else assert.equal(actual, expected, `.spec/architecture/${rel} is stale; run npm run verify:structure -- --write`);
  }
  assertAcyclic([...strata.keys()], modulePairs);
  const contracts = JSON.parse(await read('.spec/architecture/contracts.json'));
  assert.equal(contracts.version, 1);
  assert.deepEqual(contracts.forbid, []);
  assert.deepEqual(contracts.layers, [...strata.keys()].reverse().map(level => `stratum-${level}`));
  assert.deepEqual(contracts.modules, [...strata].map(([level, members]) => ({
    name: `Dependency stratum ${level}`, layer: `stratum-${level}`, paths: members,
  })));
  const index = await read('.spec/architecture/module-index.md');
  const indexed = index.split('\n').map(line => line.match(/^- `([^`]+)`$/)?.[1]).filter(Boolean);
  assert.deepEqual([...indexed].sort(), allPaths);
  const mmd = await read('.spec/architecture/module-dag.mmd');
  const md = await read('.spec/architecture/module-dag.md');
  assert.ok(md.includes(mmd.trim()));
  assert.doesNotMatch(mmd, /cycles|cycle is allowed/i);
  return { paths: paths.length, allPaths: allPaths.length, strata: strata.size, edges: modulePairs.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const regenerate = process.argv.includes('--write');
  const result = await verifyStructure({ regenerate });
  console.log(`structure OK: ${result.paths} paths, ${result.strata} strata, ${result.edges} DAG edges`);
}
