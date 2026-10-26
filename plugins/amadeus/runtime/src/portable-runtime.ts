import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveCodexExecutable } from './codex-adapter.ts';
import { PROVIDER_SIGN_IN_FOLDERS, WORKER_PROVIDERS } from './worker-providers.ts';

/** Home-folder locations a development worker never needs: credentials, tool logins, browser profiles and personal documents. */
const SENSITIVE_HOME_PATHS = [
  '.ssh', '.aws', '.azure', '.gnupg', '.docker', '.kube', '.config', '.cursor',
  // Every AI provider's sign-in folder; a worker is given back only its own.
  ...PROVIDER_SIGN_IN_FOLDERS,
  '.git-credentials', '.npmrc', '.netrc', '.pypirc',
  join('AppData', 'Roaming'), join('AppData', 'Local', 'Google'), join('AppData', 'Local', 'Microsoft', 'Edge'),
  join('AppData', 'Local', 'BraveSoftware'), join('AppData', 'Local', 'Mozilla'),
  'Documents', 'Desktop', 'Downloads', 'Pictures', 'OneDrive',
];

/** Existing sensitive home paths that do not contain the project (a worker must still reach its own project). */
export function defaultSensitivePaths(home: string, sourceRoot: string, present: (path: string) => boolean = existsSync): string[] {
  const keep = [resolve(sourceRoot), dirname(resolve(sourceRoot))].map((path) => path.toLowerCase());
  const candidates = SENSITIVE_HOME_PATHS.map((path) => resolve(home, path));
  // Live MXC probes showed a deny on AppData\Roaming does not reach every
  // application folder inside it (some carry their own ACLs), so each
  // immediate child is denied explicitly as well.
  const roaming = resolve(home, 'AppData', 'Roaming');
  if (present(roaming)) {
    try {
      for (const entry of readdirSync(roaming, { withFileTypes: true })) {
        // MXC's process minimum re-allows Roaming\Microsoft (Windows shell and
        // DPAPI-protected credential stores); listing it would claim a denial
        // the live acceptance check shows the sandbox cannot enforce.
        if (entry.isDirectory() && entry.name.toLowerCase() !== 'microsoft') candidates.push(join(roaming, entry.name));
      }
    } catch { /* an unreadable Roaming folder keeps the folder-level deny only */ }
  }
  return candidates.filter((path) => present(path)
    && !keep.some((root) => root === path.toLowerCase() || root.startsWith(`${path.toLowerCase()}${sep}`)));
}

const CODE_MODE_HOST = process.platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host';

/**
 * macOS and Linux: the first `codex` on PATH, followed through its symlink to the
 * release folder that also holds the code-mode host (where.exe does this on Windows).
 */
export function findCodexOnPath(pathVariable: string | undefined, present: (path: string) => boolean = existsSync): string | null {
  for (const folder of (pathVariable ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(folder, 'codex');
    if (!present(candidate)) continue;
    let real: string;
    try { real = realpathSync(candidate); } catch { continue; }
    if (present(join(dirname(real), 'codex-code-mode-host'))) return real;
  }
  return null;
}

/** Bind known dependencies at task execution, never enumerate installed software. */
export function portableWorkerConfig(config: Record<string, any>, sourceRoot: string, options: {
  resolveExecutable?: () => string; exists?: (path: string) => boolean;
} = {}): Record<string, any> {
  const present = options.exists ?? existsSync;
  let executable = config.executable;
  if (!executable || !isAbsolute(executable)) {
    executable = options.resolveExecutable?.() ?? resolveCodexExecutable();
    if (!isAbsolute(executable) && process.platform === 'win32') {
      try { executable = execFileSync('where.exe', ['codex.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find(path => present(join(dirname(path), CODE_MODE_HOST))) ?? ''; }
      catch { executable = ''; }
    } else if (!isAbsolute(executable)) {
      executable = findCodexOnPath(process.env.PATH, present) ?? '';
    }
  }
  const codeModeHostExecutable = config.codeModeHostExecutable ?? join(dirname(executable || '.'), CODE_MODE_HOST);
  if (!executable || !isAbsolute(executable) || !present(executable) || !isAbsolute(codeModeHostExecutable) || !present(codeModeHostExecutable)) throw new Error('A supported local Codex executable and adjacent code-mode host are required. Run dependency setup in the supported desktop host.');
  const source = resolve(sourceRoot);
  return { ...config, executable, codeModeHostExecutable,
    isolationAcceptanceHarness: config.isolationAcceptanceHarness ?? join(import.meta.dirname, 'portable-acceptance.mjs'),
    isolationSecurityStateProbe: config.isolationSecurityStateProbe ?? join(import.meta.dirname, 'Read-IsolationSecurityState.ps1'),
    assignedProjectRoot: config.assignedProjectRoot ?? source,
    readableProjectRoots: config.readableProjectRoots?.length ? config.readableProjectRoots : [source],
    deniedParentPaths: config.deniedParentPaths?.length ? config.deniedParentPaths : [dirname(source)],
    protectedPaths: config.protectedPaths?.length ? config.protectedPaths : ['.git', '.env', '.ssh', '.aws', '.codex'].map(path => join(source, path)),
    deniedSensitivePaths: config.deniedSensitivePaths ?? defaultSensitivePaths(homedir(), source, present),
    deniedSourceRoot: source,
  };
}

function executableFolder(path: string): string {
  return dirname(resolve(path));
}

/** The signed-in Claude Code executable installed for this user, or null. */
export function findClaudeExecutable(environment: NodeJS.ProcessEnv = process.env, present: (path: string) => boolean = existsSync): string | null {
  const explicit = environment.CLAUDE_EXECUTABLE?.trim();
  if (explicit && isAbsolute(explicit) && present(explicit)) return resolve(explicit);
  const roaming = environment.APPDATA ?? (environment.USERPROFILE ? join(environment.USERPROFILE, 'AppData', 'Roaming') : null);
  const candidate = roaming ? join(roaming, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : null;
  return candidate && present(candidate) ? candidate : null;
}

/**
 * The signed-in Grok Build executable (xAI's `grok` CLI), or null. Not verified
 * on a live install yet: checks GROK_EXECUTABLE, the folders its installers use,
 * then PATH. Nothing is executed to find it.
 */
export function findGrokExecutable(environment: NodeJS.ProcessEnv = process.env, present: (path: string) => boolean = existsSync): string | null {
  const explicit = environment.GROK_EXECUTABLE?.trim();
  if (explicit && isAbsolute(explicit) && present(explicit)) return resolve(explicit);
  const names = process.platform === 'win32' ? ['grok.exe'] : ['grok'];
  const home = environment.USERPROFILE || environment.HOME || '';
  const folders = [
    ...(home ? [join(home, '.grok', 'bin'), join(home, '.local', 'bin')] : []),
    ...(environment.LOCALAPPDATA ? [join(environment.LOCALAPPDATA, 'Programs', 'grok')] : []),
    ...String(environment.PATH ?? environment.Path ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean),
  ];
  for (const folder of folders) {
    for (const name of names) if (present(join(folder, name))) return resolve(folder, name);
  }
  return null;
}

/**
 * Grok Build is signed in to a subscription (grok login) rather than relying on
 * an API key. GROK_HOME relocates the folder, as the CLI itself allows.
 */
export function grokSignedIn(environment: NodeJS.ProcessEnv = process.env, present: (path: string) => boolean = existsSync): boolean {
  const folder = environment.GROK_HOME?.trim() || join(environment.USERPROFILE || environment.HOME || homedir(), '.grok');
  return present(join(folder, 'auth.json'));
}

/**
 * Copy a worker CLI executable into the Amadeus state folder. The contained
 * worker may read its executable's folder; staging keeps that grant away from
 * shared folders (such as the global npm folder) that hold other tools' files.
 */
export function stageWorkerExecutable(source: string, stateRoot: string, folder: string): string {
  const digest = createHash('sha256').update(readFileSync(source)).digest('hex');
  const destination = join(stateRoot, 'software-runtime-homes', folder, digest.slice(0, 16), basename(source));
  if (!existsSync(destination)) {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  if (createHash('sha256').update(readFileSync(destination)).digest('hex') !== digest) throw new Error('Staged worker executable hash mismatch');
  return destination;
}

export function stageClaudeExecutable(source: string, stateRoot: string): string {
  return stageWorkerExecutable(source, stateRoot, 'claude-code');
}

/**
 * A complete Claude worker config for one development goal, derived from the
 * same project scope as a Codex worker. Claude runs inside the Codex CLI's MXC
 * sandbox (`codex sandbox`), so a local Codex executable is still required on
 * Windows; no Cursor configuration is needed.
 */
export function portableClaudeConfig(config: Record<string, any>, sourceRoot: string, options: {
  stateRoot: string; claudeExecutable?: string | null; codex?: Record<string, any>;
  environment?: NodeJS.ProcessEnv; exists?: (path: string) => boolean;
}): Record<string, any> {
  const present = options.exists ?? existsSync;
  const codex = options.codex ?? portableWorkerConfig({}, sourceRoot, { exists: present });
  // The same sandbox and project scope for every Claude-style CLI; only the
  // executable, sign-in folder and output format differ (see worker-providers.ts).
  const cli: 'claude' | 'grok' = config.cli === 'grok' ? 'grok' : 'claude';
  const descriptor = WORKER_PROVIDERS.find((provider) => provider.cli === cli)!;
  const source = options.claudeExecutable ?? (config.executable && isAbsolute(config.executable) && present(config.executable)
    ? config.executable : cli === 'grok' ? findGrokExecutable(options.environment, present) : findClaudeExecutable(options.environment, present));
  if (!source) throw new Error(`A signed-in ${descriptor.label} installation is required for the ${descriptor.label} route.`);
  const executable = resolve(source).startsWith(resolve(options.stateRoot)) ? resolve(source)
    : stageWorkerExecutable(source, options.stateRoot, cli === 'grok' ? 'grok-build' : 'claude-code');
  const home = homedir();
  const providerRoot = join(options.stateRoot, 'providers', cli);
  const containedAppData = join(providerRoot, 'appdata');
  const containedUserProfile = join(providerRoot, 'profile');
  // An always-present folder outside the project that the acceptance check
  // proves unreadable, even on a machine with none of the sensitive folders.
  const denyProbe = join(providerRoot, 'deny-probe');
  for (const directory of [containedAppData, containedUserProfile, denyProbe]) mkdirSync(directory, { recursive: true });
  const configurationDirectory = config.configurationDirectory && isAbsolute(config.configurationDirectory)
    ? resolve(config.configurationDirectory)
    : cli === 'grok' && options.environment?.GROK_HOME?.trim() ? resolve(options.environment.GROK_HOME.trim()) : join(home, descriptor.signInFolder);
  // Claude's policy starts from "deny everything" and lists exceptions, so its
  // deny list names folders outside the project. Use the same credential and
  // personal folders a Codex worker is denied, minus Claude's own sign-in folder.
  const keep = (path: string) => {
    const key = resolve(path).toLowerCase();
    const needed = [configurationDirectory, executableFolder(source), options.stateRoot].map((item) => resolve(item).toLowerCase());
    return needed.some((item) => item === key || item.startsWith(`${key}${sep}`));
  };
  const deniedParentPaths = [denyProbe, ...(codex.deniedSensitivePaths ?? defaultSensitivePaths(home, sourceRoot, present))
    .filter((path: string) => !keep(path))];
  return {
    ...config,
    schemaVersion: 1,
    enabled: true, dispatchAuthorized: true, implementationPrepared: true, implementationDispatchAuthorized: true,
    automaticStartup: false, readOnlyOnly: false, developmentMode: true,
    executable, executableArguments: [],
    containmentExecutable: codex.executable, containmentProfile: 'claude_contained', containmentWindowsSandbox: 'mxc',
    containedAppData, containedUserProfile, containedUsername: config.containedUsername || 'amadeus-worker',
    userInfoShim: join(import.meta.dirname, 'claude-windows-userinfo-shim.cjs'),
    pathVerifierShim: join(import.meta.dirname, 'claude-path-verifier-shim.cjs'),
    authentication: 'subscription-signin', apiKeyAuthenticationAllowed: false, spendingRouteReviewed: true,
    cli,
    // Grok Build's Messages-compatible stream matches Claude Code's stream-json.
    outputFormat: cli === 'grok' ? 'streaming-messages-json' : 'stream-json',
    configurationDirectory,
    runtimeConfigurationRoot: config.runtimeConfigurationRoot ?? join(containedAppData, 'runtime'),
    maximumRuntimeSeconds: config.maximumRuntimeSeconds ?? codex.maximumRuntimeSeconds ?? 1800,
    maximumIdleSeconds: config.maximumIdleSeconds ?? 180,
    deniedSourceRoot: codex.deniedSourceRoot, assignedProjectRoot: codex.assignedProjectRoot,
    readableProjectRoots: codex.readableProjectRoots, deniedParentPaths,
    protectedPaths: codex.protectedPaths,
    isolationAcceptanceHarness: join(import.meta.dirname, 'claude-project-scope-acceptance.mjs'),
    isolationSecurityStateProbe: config.isolationSecurityStateProbe ?? codex.isolationSecurityStateProbe,
  };
}
