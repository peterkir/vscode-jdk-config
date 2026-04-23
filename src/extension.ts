import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

type RuntimeKind = 'jdk' | 'jre';

interface JavaRuntimeConfigEntry {
  name: string;
  path: string;
  default?: boolean;
  sources?: string;
  javadoc?: string;
  [key: string]: unknown;
}

interface DiscoveredRuntime {
  name: string;
  path: string;
  kind: RuntimeKind;
  version?: string;
  sources?: string;
  javadoc?: string;
}

const JAVA_CONFIG_SECTION = 'java';
const JAVA_RUNTIMES_KEY = 'configuration.runtimes';
const JDK_SEARCH_FOLDER_NAME = 'jdk-search';
const DIRECTORY_SKIP_NAMES = new Set([
  '.git',
  '.gradle',
  '.idea',
  '.metadata',
  '.mvn',
  '.settings',
  '.svn',
  '.vscode',
  'build',
  'dist',
  'node_modules',
  'out',
  'target'
]);

export function activate(context: vscode.ExtensionContext): void {
  const command = vscode.commands.registerCommand('vscode-jre-config.scanJavaRuntimes', async () => {
    await scanAndConfigureJavaRuntimes();
  });

  context.subscriptions.push(command);
}

export function deactivate(): void {}

async function scanAndConfigureJavaRuntimes(): Promise<void> {
  const defaultSearchRootUri = await resolveDefaultSearchRootUri();
  const roots = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: true,
    defaultUri: defaultSearchRootUri,
    openLabel: 'Scan for Java runtimes',
    title: 'Select one or more root folders to search for JDKs or JREs'
  });

  if (!roots || roots.length === 0) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Scanning selected folders for Java runtimes',
      cancellable: false
    },
    async () => {
      const discovered = await findJavaRuntimes(roots.map((uri) => uri.fsPath));

      if (discovered.length === 0) {
        vscode.window.showWarningMessage('No Java runtimes were found in the selected folders.');
        return;
      }

      const config = vscode.workspace.getConfiguration(JAVA_CONFIG_SECTION);
      const existing = config.get<JavaRuntimeConfigEntry[]>(JAVA_RUNTIMES_KEY, []);
      const { merged, added } = mergeRuntimeEntries(existing, discovered);

      if (added.length > 0) {
        await config.update(JAVA_RUNTIMES_KEY, merged, vscode.ConfigurationTarget.Global);

        const runtimeSummary = added.map((runtime) => `${runtime.name} (${runtime.kind.toUpperCase()})`).join(', ');
        vscode.window.showInformationMessage(`Added ${added.length} Java runtime${added.length === 1 ? '' : 's'} to java.configuration.runtimes: ${runtimeSummary}`);
      } else {
        vscode.window.showInformationMessage('All discovered Java runtimes are already present in java.configuration.runtimes.');
      }

      await promptAndStoreWorkspaceDefaultRuntime(config, merged);
    }
  );
}

async function resolveDefaultSearchRootUri(): Promise<vscode.Uri | undefined> {
  const explicitHome = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  const homeDirectory = explicitHome?.trim() || os.homedir();
  if (!homeDirectory) {
    return undefined;
  }

  const searchRootPath = path.join(homeDirectory, JDK_SEARCH_FOLDER_NAME);
  try {
    await fs.mkdir(searchRootPath, { recursive: true });
  } catch {
    return vscode.Uri.file(homeDirectory);
  }

  return vscode.Uri.file(searchRootPath);
}

async function findJavaRuntimes(rootPaths: string[]): Promise<DiscoveredRuntime[]> {
  const pending = [...new Set(rootPaths.map((rootPath) => path.resolve(rootPath)))];
  const visited = new Set<string>();
  const discoveredByPath = new Map<string, DiscoveredRuntime>();

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath) {
      continue;
    }

    const normalizedCurrentPath = normalizeFsPath(currentPath);
    if (visited.has(normalizedCurrentPath)) {
      continue;
    }
    visited.add(normalizedCurrentPath);

    const runtime = await inspectJavaHome(currentPath);
    if (runtime) {
      discoveredByPath.set(normalizedCurrentPath, runtime);
      continue;
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || shouldSkipDirectory(entry.name)) {
        continue;
      }

      pending.push(path.join(currentPath, entry.name));
    }
  }

  return [...discoveredByPath.values()].sort(compareDiscoveredRuntimes);
}

async function inspectJavaHome(homePath: string): Promise<DiscoveredRuntime | undefined> {
  const javaBinary = await findExistingPath([
    path.join(homePath, 'bin', 'java.exe'),
    path.join(homePath, 'bin', 'java')
  ]);

  if (!javaBinary) {
    return undefined;
  }

  const javacBinary = await findExistingPath([
    path.join(homePath, 'bin', 'javac.exe'),
    path.join(homePath, 'bin', 'javac')
  ]);
  const releaseFilePath = path.join(homePath, 'release');
  const releaseInfo = await readJavaReleaseInfo(releaseFilePath);
  const version = releaseInfo.get('JAVA_VERSION');
  const kind: RuntimeKind = javacBinary ? 'jdk' : 'jre';
  const runtimeFolderName = path.basename(homePath);
  const name = buildRuntimeName(runtimeFolderName, version);
  const sources = await findRuntimeSources(homePath);
  const javadoc = await findRuntimeJavadoc(homePath, runtimeFolderName);

  return {
    name,
    path: homePath,
    kind,
    version,
    sources,
    javadoc
  };
}

async function findExistingPath(pathsToCheck: string[]): Promise<string | undefined> {
  for (const candidatePath of pathsToCheck) {
    try {
      await fs.access(candidatePath);
      return candidatePath;
    } catch {
      // Ignore inaccessible paths and continue checking alternatives.
    }
  }

  return undefined;
}

async function readJavaReleaseInfo(releaseFilePath: string): Promise<Map<string, string>> {
  try {
    const contents = await fs.readFile(releaseFilePath, 'utf8');
    const properties = new Map<string, string>();

    for (const rawLine of contents.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }

      const separatorIndex = line.indexOf('=');
      if (separatorIndex <= 0) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      const rawValue = line.slice(separatorIndex + 1).trim();
      properties.set(key, rawValue.replace(/^"|"$/gu, ''));
    }

    return properties;
  } catch {
    return new Map<string, string>();
  }
}

function mergeRuntimeEntries(
  existing: JavaRuntimeConfigEntry[],
  discovered: DiscoveredRuntime[]
): { merged: JavaRuntimeConfigEntry[]; added: DiscoveredRuntime[] } {
  const merged = [...existing];
  const existingPaths = new Set(existing.map((entry) => normalizeFsPath(entry.path)).filter(Boolean));
  const added: DiscoveredRuntime[] = [];

  for (const runtime of discovered) {
    const normalizedPath = normalizeFsPath(runtime.path);
    if (existingPaths.has(normalizedPath)) {
      continue;
    }

    merged.push({
      name: runtime.name,
      path: runtime.path,
      ...(runtime.sources ? { sources: runtime.sources } : {}),
      ...(runtime.javadoc ? { javadoc: runtime.javadoc } : {})
    });
    existingPaths.add(normalizedPath);
    added.push(runtime);
  }

  return { merged, added };
}

function buildRuntimeName(runtimeFolderName: string, version: string | undefined): string {
  const normalizedVersion = version ? version.trim().replace(/^"|"$/gu, '') : '';
  const majorVersion = normalizedVersion ? extractJavaMajor(normalizedVersion) : undefined;
  const versionToken = majorVersion ?? normalizedVersion;

  if (!versionToken) {
    return runtimeFolderName;
  }

  const normalizedFolderName = runtimeFolderName.toLowerCase();
  const normalizedVersionToken = versionToken.toLowerCase();
  if (normalizedFolderName.includes(normalizedVersionToken)) {
    return runtimeFolderName;
  }

  return `${runtimeFolderName}_${versionToken}`;
}

async function findRuntimeSources(homePath: string): Promise<string | undefined> {
  return findExistingPath([
    path.join(homePath, 'lib', 'src.zip'),
    path.join(homePath, 'src.zip')
  ]);
}

async function findRuntimeJavadoc(homePath: string, runtimeFolderName: string): Promise<string | undefined> {
  const homeParent = path.dirname(homePath);
  const homeGrandParent = path.dirname(homeParent);
  const siblingShareJavadoc =
    path.basename(homeGrandParent).toLowerCase() === 'lib'
      ? path.join(path.dirname(homeGrandParent), 'share', 'javadoc', runtimeFolderName, 'api')
      : undefined;

  const candidates = [
    path.join(homePath, 'docs', 'api'),
    path.join(homePath, 'javadoc', 'api'),
    siblingShareJavadoc
  ].filter((candidatePath): candidatePath is string => Boolean(candidatePath));

  return findExistingPath(candidates);
}

async function promptAndStoreWorkspaceDefaultRuntime(
  config: vscode.WorkspaceConfiguration,
  runtimes: JavaRuntimeConfigEntry[]
): Promise<void> {
  if (runtimes.length === 0 || !vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    return;
  }

  const quickPickItems = runtimes
    .filter((runtime) => runtime.path)
    .map((runtime) => ({
      label: runtime.name,
      description: runtime.path,
      runtime
    }));

  if (quickPickItems.length === 0) {
    return;
  }

  const selected = await vscode.window.showQuickPick(quickPickItems, {
    title: 'Select the default Java runtime for this workspace',
    placeHolder: 'Choose which runtime should be marked as default in workspace settings',
    ignoreFocusOut: true
  });

  if (!selected) {
    return;
  }

  const selectedPath = normalizeFsPath(selected.runtime.path);
  const workspaceRuntimes = runtimes.map((runtime) => {
    const updatedRuntime: JavaRuntimeConfigEntry = { ...runtime };
    delete updatedRuntime.default;
    if (normalizeFsPath(updatedRuntime.path) === selectedPath) {
      updatedRuntime.default = true;
    }
    return updatedRuntime;
  });

  await config.update(JAVA_RUNTIMES_KEY, workspaceRuntimes, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`Set workspace default Java runtime to ${selected.runtime.name}.`);
}

function toJavaSeLabel(version: string): string | undefined {
  const major = extractJavaMajor(version);
  return major ? `JavaSE-${major}` : undefined;
}

function extractJavaMajor(version: string): string | undefined {
  const cleanedVersion = version.trim().replace(/^"|"$/gu, '');
  if (!cleanedVersion) {
    return undefined;
  }

  if (cleanedVersion.startsWith('1.')) {
    const legacyMatch = /^1\.(\d+)/u.exec(cleanedVersion);
    return legacyMatch ? `1.${legacyMatch[1]}` : undefined;
  }

  const modernMatch = /^(\d+)/u.exec(cleanedVersion);
  return modernMatch ? modernMatch[1] : undefined;
}

function shouldSkipDirectory(name: string): boolean {
  return DIRECTORY_SKIP_NAMES.has(name.toLowerCase());
}

function normalizeFsPath(filePath: string | undefined): string {
  return filePath ? path.normalize(filePath).toLowerCase() : '';
}

function compareDiscoveredRuntimes(left: DiscoveredRuntime, right: DiscoveredRuntime): number {
  const versionComparison = compareJavaVersions(left.version, right.version);
  if (versionComparison !== 0) {
    return versionComparison;
  }

  return normalizeFsPath(left.path).localeCompare(normalizeFsPath(right.path));
}

function compareJavaVersions(left: string | undefined, right: string | undefined): number {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }

  const leftParts = normalizeVersionParts(left);
  const rightParts = normalizeVersionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return rightPart - leftPart;
    }
  }

  return 0;
}

function normalizeVersionParts(version: string): number[] {
  const cleanedVersion = version.replace(/^"|"$/gu, '');
  return cleanedVersion
    .split(/[^0-9]+/u)
    .filter(Boolean)
    .map((segment) => Number.parseInt(segment, 10))
    .filter((segment) => Number.isFinite(segment));
}

export const testables = {
  buildRuntimeName,
  compareJavaVersions,
  extractJavaMajor,
  normalizeFsPath,
  normalizeVersionParts,
  shouldSkipDirectory
};
