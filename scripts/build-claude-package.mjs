import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const normalized = bytes => bytes.toString('utf8').replaceAll('\r\n', '\n');
const canonicalTextAsset = path => /\.(?:json|mjs|cjs|js|ts|md|ya?ml|txt|ps1)$/i.test(path);
const canonicalAssetBytes = (path, bytes) => canonicalTextAsset(path) ? Buffer.from(normalized(bytes)) : bytes;
const canonicalAssetHash = (path, bytes) => hash(canonicalAssetBytes(path, bytes));
const canonicalAssetEquals = (path, left, right) => canonicalAssetBytes(path, left).equals(canonicalAssetBytes(path, right));
const json = bytes => JSON.parse(bytes.toString('utf8'));
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export const CLAUDE_MARKETPLACE_NAME = 'amadeus';
export const PUBLISHED_CLAUDE_PLUGIN_DIRECTORY = 'claude-plugin';

function publicMarketplace(version, source = `./${PUBLISHED_CLAUDE_PLUGIN_DIRECTORY}`) {
  return {
    name: CLAUDE_MARKETPLACE_NAME,
    description: 'Amadeus - Local AI Orchestrator for Claude Code',
    owner: { name: 'Mad Max Systems' },
    plugins: [{
      name: 'amadeus',
      source,
      description: 'Durable local orchestration using available subscription models',
      version,
    }],
  };
}

/** Copy a staged tree without preserving symlinks/junctions (Claude validate refuses them). */
function copyTreePlain(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source).sort()) {
    const from = join(source, name);
    const to = join(destination, name);
    const st = lstatSync(from);
    if (st.isSymbolicLink()) {
      const target = realpathSync(from);
      if (statSync(target).isDirectory()) copyTreePlain(target, to);
      else {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(target, to);
      }
    } else if (st.isDirectory()) {
      copyTreePlain(from, to);
    } else if (st.isFile()) {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    } else {
      throw new Error(`Non-file package asset during marketplace copy: ${from}`);
    }
  }
}

// Walk only explicit public package trees; never follow links into local state.
function files(root, prefix = '') {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('Package directory must not be a link');
  return readdirSync(root).sort().flatMap(name => {
    const path = join(root, name), stat = lstatSync(path), key = prefix + name;
    if (stat.isSymbolicLink()) throw new Error('Linked package asset: ' + key);
    if (stat.isDirectory()) return files(path, key + '/');
    if (!stat.isFile()) throw new Error('Non-file package asset: ' + key);
    return [[key, readFileSync(path)]];
  });
}

/** Produce a complete local candidate without registering a host or enabling a worker. */
export function stageClaudePackage(repository, destination) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Amadeus requires Node 24 or later');
  const root = resolve(repository), target = resolve(destination);
  const canonical = new Map(files(join(root, 'agent-package')));
  const spec = json(canonical.get('package.json'));
  const version = json(readFileSync(join(root, 'package.json'))).version;
  if (spec.schema !== 1 || spec.host !== 'codex' || spec.name !== 'amadeus' || spec.version !== version) throw new Error('Canonical identity mismatch');
  if (!Array.isArray(spec.assets) || new Set(spec.assets).size !== spec.assets.length || spec.assets.some(p => !canonical.has(p))) throw new Error('Invalid canonical assets');
  if (canonical.size !== spec.assets.length + 1) throw new Error('Undeclared canonical assets');
  const shared = new Map(files(join(root, 'plugins/amadeus')));
  const recorded = json(shared.get('agent-package-manifest.json'));
  if (recorded.version !== version) throw new Error('Stale canonical manifest');
  for (const path of spec.assets) {
    if (!shared.get(path)?.equals(canonical.get(path)) || recorded.assets[path] !== hash(normalized(canonical.get(path)))) throw new Error('Stale canonical asset: ' + path);
  }
  const runtime = json(shared.get('runtime/manifest.json'));
  const source = new Map([
    ['package.json', readFileSync(join(root, 'package.json'))],
    ...files(join(root, 'src'), 'src/'), ...files(join(root, 'config-templates'), 'config-templates/'),
  ]);
  if (Object.keys(runtime).length !== source.size) throw new Error('Stale runtime manifest');
  for (const [path, bytes] of source) {
    const expected = normalized(bytes).trimEnd() + '\n';
    if (runtime[path] !== hash(expected) || !shared.has('runtime/' + path) || normalized(shared.get('runtime/' + path)) !== expected) throw new Error('Stale runtime asset: ' + path);
  }
  const assets = new Map();
  for (const path of spec.assets) {
    if (path.startsWith('skills/') && path.endsWith('/SKILL.md') || ['config.example.json', 'privacy-flows.json', 'hooks/session-start.mjs'].includes(path)) assets.set(path, Buffer.from(normalized(canonical.get(path))));
    else if (!['.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json'].includes(path) && !/^skills\/[^/]+\/agents\/openai.yaml$/.test(path)) throw new Error('Unmapped canonical requirement: ' + path);
  }
  for (const [path, bytes] of shared) {
    if (path.startsWith('scripts/')) {
      if (!/^scripts\/[\w-]+\.mjs$/.test(path)) throw new Error('Unexpected shared script asset: ' + path);
      assets.set(path, Buffer.from(normalized(bytes).trimEnd() + '\n'));
    } else if (path.startsWith('runtime/')) {
      if (path !== 'runtime/manifest.json' && !source.has(path.slice(8))) throw new Error('Unexpected runtime asset: ' + path);
      assets.set(path, Buffer.from(normalized(bytes)));
    } else if (!spec.assets.includes(path) && path !== 'agent-package-manifest.json') throw new Error('Unexpected public package asset: ' + path);
  }
  if (!assets.has('scripts/server.mjs')) throw new Error('Missing MCP server');
  const mcp = json(canonical.get('.mcp.json'));
  if (mcp.mcpServers?.amadeus?.command !== 'node' || JSON.stringify(mcp.mcpServers.amadeus.args) !== '["./scripts/server.mjs"]' || Object.keys(mcp.mcpServers).length !== 1) throw new Error('Unsupported MCP mapping');
  mcp.mcpServers.amadeus.args = ['${CLAUDE_PLUGIN_ROOT}/scripts/server.mjs'];
  const hooks = json(canonical.get('hooks/hooks.json'));
  const hook = hooks.hooks?.SessionStart?.[0]?.hooks?.[0];
  if (hook?.command !== 'node "${PLUGIN_ROOT}/hooks/session-start.mjs"') throw new Error('Unsupported hook mapping');
  hook.command = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"';
  if (JSON.stringify(hooks).includes('${PLUGIN_ROOT}')) throw new Error('Unmapped hook requirement');
  assets.set('.mcp.json', encode(mcp));
  assets.set('hooks/hooks.json', encode(hooks));
  // Default component discovery prevents duplicate SessionStart registration.
  assets.set('.claude-plugin/plugin.json', encode({ name: spec.name, displayName: 'Amadeus', version, description: 'Amadeus local coordinator candidate', author: { name: 'Mad Max Systems' }, license: 'Apache-2.0' }));
  const manifest = { schema: 1, host: 'claude-code-cli', version, status: 'candidate-unverified', assets: Object.fromEntries([...assets].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => [path, canonicalAssetHash(path, bytes)])) };
  assets.set('amadeus-host-manifest.json', encode(manifest));
  // Exclusive directory creation: never overwrite a prior candidate, cache or state.
  mkdirSync(target);
  for (const [path, bytes] of assets) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    writeFileSync(join(target, path), bytes, { flag: 'wx' });
  }
  return manifest;
}

export function verifyClaudePackage(directory, expectedManifest) {
  const assets = new Map(files(resolve(directory)));
  const recorded = json(assets.get('amadeus-host-manifest.json'));
  if (JSON.stringify(recorded) !== JSON.stringify(expectedManifest)) throw new Error('Candidate manifest changed');
  if (assets.size !== Object.keys(expectedManifest.assets).length + 1) throw new Error('Unexpected candidate assets');
  for (const [path, digest] of Object.entries(expectedManifest.assets)) {
    if (!assets.has(path) || canonicalAssetHash(path, assets.get(path)) !== digest) throw new Error('Candidate integrity mismatch: ' + path);
  }
  return true;
}

/**
 * Stage a Claude Code marketplace directory that lists the Amadeus candidate.
 * Layout matches the official local-marketplace walkthrough:
 *   <marketplace>/.claude-plugin/marketplace.json
 *   <marketplace>/amadeus/…candidate assets…
 */
export function stageClaudeMarketplace(repository, destination, options = {}) {
  const target = resolve(destination);
  if (existsSync(target)) throw new Error(`Claude marketplace destination already exists: ${target}`);
  mkdirSync(dirname(target), { recursive: true });
  const ownsCandidate = !options.candidateDirectory;
  const candidateRoot = ownsCandidate
    ? join(dirname(target), `${basename(target)}.candidate-tmp`)
    : resolve(options.candidateDirectory);
  if (ownsCandidate && existsSync(candidateRoot)) {
    rmSync(candidateRoot, { recursive: true, force: true });
  }
  let manifest;
  if (ownsCandidate) {
    manifest = stageClaudePackage(repository, candidateRoot);
  } else {
    manifest = json(readFileSync(join(candidateRoot, 'amadeus-host-manifest.json')));
    verifyClaudePackage(candidateRoot, manifest);
  }
  mkdirSync(target);
  const pluginRoot = join(target, 'amadeus');
  copyTreePlain(candidateRoot, pluginRoot);
  mkdirSync(join(target, '.claude-plugin'), { recursive: true });
  writeFileSync(join(target, '.claude-plugin', 'marketplace.json'), encode(publicMarketplace(manifest.version, './amadeus')), { flag: 'wx' });
  if (ownsCandidate) rmSync(candidateRoot, { recursive: true, force: true });
  return {
    marketplaceRoot: target,
    pluginRoot,
    marketplaceName: CLAUDE_MARKETPLACE_NAME,
    pluginId: `amadeus@${CLAUDE_MARKETPLACE_NAME}`,
    manifest,
  };
}

/** Build or verify the public GitHub marketplace stored in the repository. */
export function publishClaudeMarketplace(repository, options = {}) {
  const root = resolve(repository);
  const target = join(root, PUBLISHED_CLAUDE_PLUGIN_DIRECTORY);
  const catalogPath = join(root, '.claude-plugin', 'marketplace.json');
  const temporary = mkdtempSync(join(tmpdir(), 'amadeus-claude-public-'));
  const expected = join(temporary, PUBLISHED_CLAUDE_PLUGIN_DIRECTORY);
  try {
    const manifest = stageClaudePackage(root, expected);
    const catalog = encode(publicMarketplace(manifest.version));
    if (options.check) {
      if (!existsSync(target)) throw new Error(`Published Claude plugin missing: ${target}`);
      verifyClaudePackage(target, manifest);
      const expectedFiles = new Map(files(expected));
      const actualFiles = new Map(files(target));
      if (expectedFiles.size !== actualFiles.size) throw new Error('Published Claude plugin has unexpected files');
      for (const [path, bytes] of expectedFiles) {
        if (!actualFiles.has(path) || !canonicalAssetEquals(path, actualFiles.get(path), bytes)) throw new Error(`Published Claude plugin is stale: ${path}`);
      }
      if (!existsSync(catalogPath) || !canonicalAssetEquals('.claude-plugin/marketplace.json', readFileSync(catalogPath), catalog)) throw new Error('Published Claude marketplace catalog is stale');
      return { manifest, target, catalogPath, checked: true };
    }
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    copyTreePlain(expected, target);
    mkdirSync(dirname(catalogPath), { recursive: true });
    writeFileSync(catalogPath, catalog);
    return { manifest, target, catalogPath, checked: false };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const mode = process.argv[2];
  if (mode === '--marketplace') {
    if (process.argv.length !== 4) throw new Error('Usage: node scripts/build-claude-package.mjs --marketplace <new-marketplace-directory>');
    const staged = stageClaudeMarketplace(process.cwd(), process.argv[3]);
    console.log(`Staged Claude marketplace ${staged.manifest.version} at ${staged.marketplaceRoot}; plugin id ${staged.pluginId}.`);
  } else if (mode === '--publish' || mode === '--check-published') {
    if (process.argv.length !== 3) throw new Error(`Usage: node scripts/build-claude-package.mjs ${mode}`);
    const result = publishClaudeMarketplace(process.cwd(), { check: mode === '--check-published' });
    console.log(`${result.checked ? 'Verified' : 'Built'} public Claude marketplace ${result.manifest.version}; plugin id amadeus@${CLAUDE_MARKETPLACE_NAME}.`);
  } else {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/build-claude-package.mjs <new-candidate-directory>');
    const manifest = stageClaudePackage(process.cwd(), process.argv[2]);
    verifyClaudePackage(process.argv[2], manifest);
    console.log(`Staged Claude candidate ${manifest.version}; host and signed-in worker remain unverified.`);
  }
}
