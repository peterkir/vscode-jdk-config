import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { findNodeAtLocation, getNodeValue, parseTree } from 'jsonc-parser';

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
const VENDOR_PATTERNS: Array<[RegExp, string]> = [
  [/adoptium|temurin/iu, 'Temurin'],
  [/adoptopenjdk/iu, 'AdoptOpenJDK'],
  [/azul|zulu/iu, 'Azul'],
  [/oracle/iu, 'Oracle'],
  [/amazon|corretto/iu, 'Corretto'],
  [/bellsoft|liberica/iu, 'Liberica'],
  [/microsoft/iu, 'Microsoft'],
  [/red\s*hat/iu, 'Red Hat'],
  [/sap/iu, 'SapMachine'],
  [/ibm|semeru/iu, 'IBM'],
  [/graalvm/iu, 'GraalVM'],
  [/alibaba|dragonwell/iu, 'Dragonwell'],
  [/tencent|kona/iu, 'Kona'],
  [/debian|ubuntu|n\/a/iu, 'OpenJDK']
];
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
    await scanAndConfigureJavaRuntimes(results, resolveUserSettingsUri(context.globalStorageUri));
  });

  context.subscriptions.push(command, results);
}

export function deactivate(): void {}

async function scanAndConfigureJavaRuntimes(results: vscode.OutputChannel, userSettingsUri: vscode.Uri): Promise<void> {
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

      const config = vscode.workspace.getConfiguration(JAVA_CONFIG_SECTION);
      const inspected = config.inspect<JavaRuntimeConfigEntry[]>(JAVA_RUNTIMES_KEY);
      const globalRuntimes = inspected?.globalValue ?? [];
      const configuredPaths = new Map([...globalRuntimes, ...(inspected?.workspaceValue ?? [])]
        .map((runtime) => runtime.path)
        .filter((runtimePath): runtimePath is string => typeof runtimePath === 'string' && Boolean(runtimePath))
        .map((runtimePath) => [normalizeFsPath(runtimePath), runtimePath]));
      const discoveredByPath = new Map(discovered.map((runtime) => [normalizeFsPath(runtime.path), runtime]));
      const invalidPaths: string[] = [];
      for (const [normalizedPath, runtimePath] of configuredPaths) {
        if (discoveredByPath.has(normalizedPath)) {
          continue;
        }
        const runtime = await inspectJavaHome(runtimePath);
        if (runtime) {
          discoveredByPath.set(normalizedPath, runtime);
        } else {
          invalidPaths.push(runtimePath);
        }
      }

      const { merged, added, updated } = mergeRuntimeEntries(globalRuntimes, [
        ...discovered,
        ...globalRuntimes.map((runtime) => discoveredByPath.get(normalizeFsPath(runtime.path))).filter((runtime): runtime is DiscoveredRuntime => Boolean(runtime))
      ]);

      if (JSON.stringify(merged) !== JSON.stringify(globalRuntimes)) {
        await config.update(JAVA_RUNTIMES_KEY, merged, vscode.ConfigurationTarget.Global);
      }

      const workspacePaths = new Set(inspected?.workspaceValue?.map((runtime) => normalizeFsPath(runtime.path)) ?? []);
      const workspaceRuntimes = inspected?.workspaceValue
        ? mergeWorkspaceRuntimes(
            mergeRuntimeEntries(inspected.workspaceValue, [...discoveredByPath.values()].filter((runtime) =>
              workspacePaths.has(normalizeFsPath(runtime.path))
            )).merged,
            merged,
            new Set(discoveredByPath.keys())
          )
        : merged;
      if (inspected?.workspaceValue && JSON.stringify(workspaceRuntimes) !== JSON.stringify(inspected.workspaceValue)) {
        await config.update(JAVA_RUNTIMES_KEY, workspaceRuntimes, vscode.ConfigurationTarget.Workspace);
      }

      const addedPaths = new Set(added.map((runtime) => normalizeFsPath(runtime.path)));
      const updatedPaths = new Set(updated.map((runtime) => normalizeFsPath(runtime.path)));
      results.clear();
      results.appendLine(`Found ${discovered.length} Java runtimes; added ${added.length} to user settings; updated ${updated.length}; ${invalidPaths.length} configured paths could not be validated.`);
      for (const runtime of discovered) {
        const status = addedPaths.has(normalizeFsPath(runtime.path)) ? 'ADDED' : updatedPaths.has(normalizeFsPath(runtime.path)) ? 'UPDATED' : 'ALREADY PRESENT';
        results.appendLine(`${status}: ${runtime.label || runtime.name} [${runtime.name}] ${runtime.kind.toUpperCase()} ${runtime.version ?? 'version unknown'} - ${runtime.path}`);
      }
      for (const runtimePath of invalidPaths) {
        results.appendLine(`NOT VALIDATED: ${runtimePath}`);
      }
      results.show(true);
      vscode.window.showInformationMessage(`Found ${discovered.length} Java runtimes; added ${added.length}, updated ${updated.length} in user settings. Details in Java Runtime Configurator output.`);

      await promptAndStoreWorkspaceDefaultRuntime(config, workspaceRuntimes, discoveredByPath);
      await updateRuntimeSettingComments(
        userSettingsUri,
        [JAVA_CONFIG_SECTION + '.' + JAVA_RUNTIMES_KEY],
        discoveredByPath,
        results
      );
      const workspaceSettings = resolveWorkspaceSettingsDocument();
      if (workspaceSettings) {
        await updateRuntimeSettingComments(workspaceSettings.uri, workspaceSettings.path, discoveredByPath, results);
      }
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

function resolveUserHomeDirectory(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv, fallbackHome: string): string | undefined {
  const explicitHome = platform === 'win32' ? environment.USERPROFILE : environment.HOME;
  return explicitHome?.trim() || fallbackHome?.trim() || undefined;
}

async function resolveDefaultSearchRootUri(): Promise<vscode.Uri | undefined> {
  const homeDirectory = resolveUserHomeDirectory(process.platform, process.env, os.homedir());
  return homeDirectory ? vscode.Uri.file(homeDirectory) : undefined;
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

    // Symlinked runtimes resolve to the same target; keep only one entry per real location.
    const realCurrentPath = await resolveRealPath(currentPath);
    if (realCurrentPath !== normalizedCurrentPath) {
      if (visited.has(realCurrentPath)) {
        continue;
      }
      visited.add(realCurrentPath);
    }

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
      if (shouldSkipDirectory(entry.name)) {
        continue;
      }

      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory() || (entry.isSymbolicLink() && (await isDirectoryPath(entryPath)))) {
        pending.push(entryPath);
      }
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
  const label = buildRuntimeLabel(runtimeFolderName, version, {
    kind,
    vendor: resolveVendor(releaseInfo),
    runtimeVersion: releaseInfo.get('JAVA_RUNTIME_VERSION')
  });
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
): { merged: JavaRuntimeConfigEntry[]; added: DiscoveredRuntime[]; updated: DiscoveredRuntime[] } {
  const merged = existing.map((entry) => {
    const cleaned = { ...entry };
    delete cleaned.label;
    return cleaned;
  });
  const existingPaths = new Map(existing.map((entry, index) => [normalizeFsPath(entry.path), index] as const).filter(([runtimePath]) => Boolean(runtimePath)));
  const added: DiscoveredRuntime[] = [];
  const updated: DiscoveredRuntime[] = [];

  for (const runtime of discovered) {
    const normalizedPath = normalizeFsPath(runtime.path);
    const existingIndex = existingPaths.get(normalizedPath);
    if (existingIndex !== undefined) {
      const previous = merged[existingIndex];
      const refreshed = refreshRuntimeEntry(previous, runtime);
      if (JSON.stringify(refreshed) !== JSON.stringify(previous)) {
        merged[existingIndex] = refreshed;
        updated.push(runtime);
      }
      continue;
    }

    merged.push({
      name: runtime.name,
      path: runtime.path,
      ...(runtime.sources ? { sources: runtime.sources } : {}),
      ...(runtime.javadoc ? { javadoc: runtime.javadoc } : {})
    });
    existingPaths.set(normalizedPath, merged.length - 1);
    added.push(runtime);
  }

  return { merged, added, updated };
}

function mergeWorkspaceRuntimes(workspaceRuntimes: JavaRuntimeConfigEntry[], userRuntimes: JavaRuntimeConfigEntry[], validatedPaths = new Set(userRuntimes.map((runtime) => normalizeFsPath(runtime.path)))): JavaRuntimeConfigEntry[] {
  const merged = [...workspaceRuntimes];
  const paths = new Map(merged.map((runtime, index) => [normalizeFsPath(runtime.path), index] as const));
  for (const runtime of userRuntimes) {
    const normalizedPath = normalizeFsPath(runtime.path);
    const existingIndex = paths.get(normalizedPath);
    if (existingIndex === undefined) {
      const workspaceRuntime = { ...runtime };
      delete workspaceRuntime.default;
      merged.push(workspaceRuntime);
      paths.set(normalizedPath, merged.length - 1);
    } else if (validatedPaths.has(normalizedPath)) {
      merged[existingIndex] = refreshRuntimeEntry(merged[existingIndex], runtime);
    }
  }
  return merged;
}

function refreshRuntimeEntry(previous: JavaRuntimeConfigEntry, runtime: Pick<JavaRuntimeConfigEntry, 'name' | 'sources' | 'javadoc'>): JavaRuntimeConfigEntry {
  const refreshed = { ...previous, name: runtime.name };
  delete refreshed.label;
  if (runtime.sources) {
    refreshed.sources = runtime.sources;
  } else {
    delete refreshed.sources;
  }
  if (runtime.javadoc) {
    refreshed.javadoc = runtime.javadoc;
  } else {
    delete refreshed.javadoc;
  }
  return refreshed;
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

function buildRuntimeLabel(
  runtimeFolderName: string,
  version: string | undefined,
  details?: { kind?: RuntimeKind; vendor?: string; runtimeVersion?: string }
): string {
  if (!details?.kind) {
    return buildRuntimeName(runtimeFolderName, version);
  }

  const major = version ? extractJavaMajor(version) : undefined;
  const prefix = major ? `[${details.kind.toUpperCase()} ${major}]` : `[${details.kind.toUpperCase()}]`;
  const fullVersion = (details.runtimeVersion ?? version)?.trim().replace(/^"|"$/gu, '');
  const suffix = [details.vendor, fullVersion].filter(Boolean).join(' ');

  return `${prefix} ${suffix || buildRuntimeName(runtimeFolderName, version)}`;
}

function resolveVendor(releaseInfo: Map<string, string>): string | undefined {
  const implementorVersion = releaseInfo.get('IMPLEMENTOR_VERSION')?.trim();
  const candidates = [implementorVersion, releaseInfo.get('IMPLEMENTOR'), releaseInfo.get('JAVA_RUNTIME_VERSION')];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const match = VENDOR_PATTERNS.find(([pattern]) => pattern.test(candidate));
    if (match) {
      return match[1];
    }
  }

  // Vendor builds often encode their brand as "<Brand>-<version>" in IMPLEMENTOR_VERSION.
  const brandMatch = implementorVersion ? /^([A-Za-z][A-Za-z ]*?)[-_ ]?\d/u.exec(implementorVersion) : undefined;
  return brandMatch?.[1].trim() || releaseInfo.get('IMPLEMENTOR')?.trim() || undefined;
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
  runtimes: JavaRuntimeConfigEntry[],
  discoveredByPath: ReadonlyMap<string, DiscoveredRuntime>
): Promise<void> {
  if (runtimes.length === 0 || !vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    return;
  }

  const quickPickItems = runtimes
    .filter((runtime) => runtime.path)
    .map((runtime) => {
      const discovered = discoveredByPath.get(normalizeFsPath(runtime.path));
      return {
        label: discovered?.label ? `${discovered.label} (${runtime.name})` : runtime.name,
        description: runtime.path,
        runtime
      };
    });

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

function resolveWorkspaceSettingsDocument(): { uri: vscode.Uri; path: string[] } | undefined {
  if (vscode.workspace.workspaceFile) {
    return {
      uri: vscode.workspace.workspaceFile,
      path: ['settings', JAVA_CONFIG_SECTION + '.' + JAVA_RUNTIMES_KEY]
    };
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  return workspaceFolder
    ? {
        uri: vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'settings.json'),
        path: [JAVA_CONFIG_SECTION + '.' + JAVA_RUNTIMES_KEY]
      }
    : undefined;
}

function resolveUserSettingsUri(globalStorageUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(globalStorageUri, '..', '..', 'settings.json');
}

async function updateRuntimeSettingComments(
  settingsUri: vscode.Uri,
  propertyPath: string[],
  discoveredByPath: ReadonlyMap<string, DiscoveredRuntime>,
  results: vscode.OutputChannel
): Promise<void> {
  try {
    const contents = Buffer.from(await vscode.workspace.fs.readFile(settingsUri)).toString('utf8');
    const updated = updateRuntimeCommentsInText(contents, propertyPath, discoveredByPath);
    if (updated !== contents) {
      await vscode.workspace.fs.writeFile(settingsUri, Buffer.from(updated, 'utf8'));
    }
  } catch (error) {
    results.appendLine(`Could not update runtime comments in ${settingsUri.toString()}: ${String(error)}`);
  }
}

function updateRuntimeCommentsInText(
  contents: string,
  propertyPath: string[],
  discoveredByPath: ReadonlyMap<string, Pick<DiscoveredRuntime, 'path' | 'label'>>
): string {
  const root = parseTree(contents);
  const runtimesNode = root ? findNodeAtLocation(root, propertyPath) : undefined;
  if (!runtimesNode?.children) {
    return contents;
  }

  const labels = new Map([...discoveredByPath.values()]
    .filter((runtime): runtime is Pick<DiscoveredRuntime, 'path'> & { label: string } => Boolean(runtime.label))
    .map((runtime) => [normalizeFsPath(runtime.path), runtime.label.replace(/[\r\n]+/gu, ' ')]));
  const lineEnding = contents.includes('\r\n') ? '\r\n' : '\n';
  const edits: Array<{ offset: number; length: number; text: string }> = [];

  for (const entryNode of runtimesNode.children) {
    const entry = getNodeValue(entryNode) as JavaRuntimeConfigEntry;
    const label = labels.get(normalizeFsPath(entry.path));
    if (!label) {
      continue;
    }

    const lineStart = contents.lastIndexOf('\n', entryNode.offset - 1) + 1;
    const indentation = contents.slice(lineStart, entryNode.offset);
    if (!/^\s*$/u.test(indentation)) {
      continue;
    }

    const comment = `${indentation}// ${label}${lineEnding}`;
    const previousLineEnd = Math.max(0, lineStart - lineEnding.length);
    const previousLineStart = contents.lastIndexOf('\n', previousLineEnd - 1) + 1;
    const previousLine = contents.slice(previousLineStart, previousLineEnd).replace(/\r$/u, '');
    if (/^\s*\/\/ \[(?:JDK|JRE)(?: [^\]]+)?\].*$/u.test(previousLine)) {
      edits.push({ offset: previousLineStart, length: lineStart - previousLineStart, text: comment });
    } else {
      edits.push({ offset: lineStart, length: 0, text: comment });
    }
  }

  return edits
    .sort((left, right) => right.offset - left.offset)
    .reduce((updated, edit) => updated.slice(0, edit.offset) + edit.text + updated.slice(edit.offset + edit.length), contents);
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

async function resolveRealPath(filePath: string): Promise<string> {
  try {
    return normalizeFsPath(await fs.realpath(filePath));
  } catch {
    return normalizeFsPath(filePath);
  }
}

async function isDirectoryPath(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
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
  resolveUserHomeDirectory,
  resolveUserSettingsUri,
  resolveVendor,
  shouldSkipDirectory,
  toJavaSeLabel,
  updateRuntimeCommentsInText
};
