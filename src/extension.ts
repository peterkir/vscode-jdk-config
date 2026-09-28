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
  label?: string;
  [key: string]: unknown;
}

interface DiscoveredRuntime {
  name: string;
  path: string;
  kind: RuntimeKind;
  version?: string;
  label?: string;
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
  const results = vscode.window.createOutputChannel('Java Runtime Configurator');
  const command = vscode.commands.registerCommand('vscode-jre-config.scanJavaRuntimes', async () => {
    await scanAndConfigureJavaRuntimes(results);
  });

  context.subscriptions.push(command, results);
}

export function deactivate(): void {}

async function scanAndConfigureJavaRuntimes(results: vscode.OutputChannel): Promise<void> {
  const choice = await vscode.window.showQuickPick(['Scan common Java installation locations', 'Choose folders...'], {
    title: 'Where should Java runtimes be searched?'
  });
  if (!choice) {
    return;
  }

  let roots: string[];
  if (choice === 'Scan common Java installation locations') {
    const candidates = getDefaultJavaSearchPaths(process.platform, os.homedir(), process.env);
    const existing = await Promise.all(candidates.map(async (candidate) => {
      try {
        return (await fs.stat(candidate)).isDirectory() ? candidate : undefined;
      } catch {
        return undefined;
      }
    }));
    roots = existing.filter((candidate): candidate is string => Boolean(candidate));
    if (roots.length === 0) {
      vscode.window.showWarningMessage('No common Java installation folders were found. Choose folders to scan instead.');
      return;
    }
  } else {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: true,
      defaultUri: await resolveDefaultSearchRootUri(),
      openLabel: 'Scan for Java runtimes',
      title: 'Select one or more root folders to search for JDKs or JREs'
    });
    roots = selected?.map((uri) => uri.fsPath) ?? [];
  }

  if (roots.length === 0) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Scanning selected folders for Java runtimes',
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: `Scanning ${roots.length} selected folder${roots.length === 1 ? '' : 's'}...` });
      const discovered = await findJavaRuntimes(roots, (folders, found) => {
        progress.report({ message: `Scanned ${folders} folders; found ${found} Java runtimes` });
      });

      if (discovered.length === 0) {
        results.clear();
        results.appendLine('No Java runtimes found in the selected folders.');
        vscode.window.showWarningMessage('No Java runtimes were found in the selected folders.');
        return;
      }

      const config = vscode.workspace.getConfiguration(JAVA_CONFIG_SECTION);
      const inspected = config.inspect<JavaRuntimeConfigEntry[]>(JAVA_RUNTIMES_KEY);
      const { merged, added } = mergeRuntimeEntries(inspected?.globalValue ?? [], discovered);

      if (added.length > 0) {
        await config.update(JAVA_RUNTIMES_KEY, merged, vscode.ConfigurationTarget.Global);
      }

      const workspaceRuntimes = inspected?.workspaceValue
        ? mergeWorkspaceRuntimes(inspected.workspaceValue, merged)
        : merged;
      if (inspected?.workspaceValue && workspaceRuntimes.length !== inspected.workspaceValue.length) {
        await config.update(JAVA_RUNTIMES_KEY, workspaceRuntimes, vscode.ConfigurationTarget.Workspace);
      }

      const addedPaths = new Set(added.map((runtime) => normalizeFsPath(runtime.path)));
      results.clear();
      results.appendLine(`Found ${discovered.length} Java runtimes; added ${added.length} to user settings; ${discovered.length - added.length} already present.`);
      for (const runtime of discovered) {
        const status = addedPaths.has(normalizeFsPath(runtime.path)) ? 'ADDED' : 'ALREADY PRESENT';
        results.appendLine(`${status}: ${runtime.label || runtime.name} [${runtime.name}] ${runtime.kind.toUpperCase()} ${runtime.version ?? 'version unknown'} - ${runtime.path}`);
      }
      results.show(true);
      vscode.window.showInformationMessage(`Found ${discovered.length} Java runtimes; added ${added.length} to user settings. Details in Java Runtime Configurator output.`);

      await promptAndStoreWorkspaceDefaultRuntime(config, workspaceRuntimes);
    }
  );
}

function getDefaultJavaSearchPaths(platform: NodeJS.Platform, homeDirectory: string, environment: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const programFiles = [environment.ProgramFiles, environment['ProgramFiles(x86)']].filter((folder): folder is string => Boolean(folder));
    const vendorFolders = ['Java', 'Eclipse Adoptium', 'Adoptium', 'Azul Systems', 'Zulu', 'GraalVM', 'Amazon Corretto'];
    return [
      ...programFiles.flatMap((folder) => vendorFolders.map((vendor) => path.win32.join(folder, vendor))),
      path.win32.join(homeDirectory, '.jdks')
    ];
  }

  if (platform === 'darwin') {
    return [
      '/Library/Java/JavaVirtualMachines',
      path.join(homeDirectory, 'Library', 'Java', 'JavaVirtualMachines'),
      '/opt/homebrew/Cellar/openjdk',
      '/usr/local/Cellar/openjdk',
      path.join(homeDirectory, '.sdkman', 'candidates', 'java')
    ];
  }

  return [
    '/usr/lib/jvm',
    '/usr/java',
    '/opt/java',
    '/opt/jdk',
    '/opt/temurin',
    '/opt/graalvm',
    '/opt/azul',
    '/opt/zulu',
    '/opt/amazon-corretto',
    path.join(homeDirectory, '.sdkman', 'candidates', 'java'),
    path.join(homeDirectory, '.jdks')
  ];
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

async function findJavaRuntimes(rootPaths: string[], onProgress?: (folders: number, found: number) => void): Promise<DiscoveredRuntime[]> {
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
      onProgress?.(visited.size, discoveredByPath.size);
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
    if (visited.size % 25 === 0) {
      onProgress?.(visited.size, discoveredByPath.size);
    }
  }

  onProgress?.(visited.size, discoveredByPath.size);
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
  const name = buildExecutionEnvironmentName(version, runtimeFolderName);
  const label = buildRuntimeLabel(runtimeFolderName, version);
  const sources = await findRuntimeSources(homePath);
  const javadoc = await findRuntimeJavadoc(homePath, runtimeFolderName);

  return {
    name,
    path: homePath,
    kind,
    version,
    label,
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
      ...(runtime.label ? { label: runtime.label } : {}),
      ...(runtime.sources ? { sources: runtime.sources } : {}),
      ...(runtime.javadoc ? { javadoc: runtime.javadoc } : {})
    });
    existingPaths.add(normalizedPath);
    added.push(runtime);
  }

  return { merged, added };
}

function mergeWorkspaceRuntimes(workspaceRuntimes: JavaRuntimeConfigEntry[], userRuntimes: JavaRuntimeConfigEntry[]): JavaRuntimeConfigEntry[] {
  const merged = [...workspaceRuntimes];
  const paths = new Set(merged.map((runtime) => normalizeFsPath(runtime.path)));
  for (const runtime of userRuntimes) {
    const normalizedPath = normalizeFsPath(runtime.path);
    if (!paths.has(normalizedPath)) {
      const workspaceRuntime = { ...runtime };
      delete workspaceRuntime.default;
      merged.push(workspaceRuntime);
      paths.add(normalizedPath);
    }
  }
  return merged;
}

function buildExecutionEnvironmentName(version: string | undefined, fallbackFolderName: string): string {
  if (version) {
    const eeLabel = toJavaSeLabel(version);
    if (eeLabel) {
      return eeLabel;
    }
  }

  // Attempt to extract major version from folder name (e.g. JAVA17, Java-21)
  const folderMajor = extractJavaMajor(fallbackFolderName);
  if (folderMajor) {
    return folderMajor.startsWith('1.') || Number.parseInt(folderMajor, 10) <= 5
      ? (folderMajor === '1.5' ? 'J2SE-1.5' : `JavaSE-${folderMajor}`)
      : `JavaSE-${folderMajor}`;
  }

  return fallbackFolderName;
}

function buildRuntimeLabel(runtimeFolderName: string, version: string | undefined): string {
  return buildRuntimeName(runtimeFolderName, version);
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
      label: runtime.label ? `${runtime.label} (${runtime.name})` : runtime.name,
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
  if (!major) {
    return undefined;
  }
  if (major === '1.5') {
    return 'J2SE-1.5';
  }
  return `JavaSE-${major}`;
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

  // Handle forms like 21.0.2, 21-ea, JAVA21, jdk-17, etc.
  const modernMatch = /(?:^|[^\d])(\d+)(?:[^\d]|$)/u.exec(cleanedVersion);
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
  buildExecutionEnvironmentName,
  buildRuntimeLabel,
  buildRuntimeName,
  compareJavaVersions,
  extractJavaMajor,
  findJavaRuntimes,
  getDefaultJavaSearchPaths,
  mergeRuntimeEntries,
  mergeWorkspaceRuntimes,
  normalizeFsPath,
  normalizeVersionParts,
  shouldSkipDirectory,
  toJavaSeLabel
};
