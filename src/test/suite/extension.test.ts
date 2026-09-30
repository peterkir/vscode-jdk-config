import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { testables } from '../../extension';

describe('Extension Test Suite', () => {
  it('registers scan command', async () => {
    const extension = vscode.extensions.getExtension('klibio.vscode-jre-config');
    assert.ok(extension);
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('vscode-jre-config.scanJavaRuntimes'));
  });

  it('builds canonical execution environment name for JDT LS', () => {
    assert.equal(testables.buildExecutionEnvironmentName('21.0.2', 'JAVA21'), 'JavaSE-21');
    assert.equal(testables.buildExecutionEnvironmentName('17.0.10', 'JAVA17'), 'JavaSE-17');
    assert.equal(testables.buildExecutionEnvironmentName('11.0.22', 'JAVA11'), 'JavaSE-11');
    assert.equal(testables.buildExecutionEnvironmentName('1.8.0_412', 'JAVA8'), 'JavaSE-1.8');
    assert.equal(testables.buildExecutionEnvironmentName('1.5.0_22', 'JAVA5'), 'J2SE-1.5');
    // Fallback when release version missing but folder name has version
    assert.equal(testables.buildExecutionEnvironmentName(undefined, 'JAVA21-JAVAFX'), 'JavaSE-21');
  });

  it('builds descriptive label preserving folder and version details', () => {
    assert.equal(testables.buildRuntimeLabel('JAVA21-JAVAFX', '21.0.2'), 'JAVA21-JAVAFX');
    assert.equal(testables.buildRuntimeLabel('jdk-custom', '17.0.10'), 'jdk-custom_17');
  });

  it('labels runtimes with kind, major version, vendor and full version', () => {
    assert.equal(
      testables.buildRuntimeLabel('JAVA25', '25.0.4.1', { kind: 'jdk', vendor: 'Temurin', runtimeVersion: '25.0.4.1+1-LTS' }),
      '[JDK 25] Temurin 25.0.4.1+1-LTS'
    );
    assert.equal(
      testables.buildRuntimeLabel('jre-8', '1.8.0_412', { kind: 'jre', vendor: 'Oracle' }),
      '[JRE 1.8] Oracle 1.8.0_412'
    );
    assert.equal(testables.buildRuntimeLabel('jdk-lts', '21.0.2', { kind: 'jdk' }), '[JDK 21] 21.0.2');
  });

  it('detects the vendor from release metadata', () => {
    assert.equal(
      testables.resolveVendor(new Map([['IMPLEMENTOR', 'Eclipse Adoptium'], ['IMPLEMENTOR_VERSION', 'Temurin-25.0.4.1+1']])),
      'Temurin'
    );
    assert.equal(testables.resolveVendor(new Map([['IMPLEMENTOR', 'Azul Systems, Inc.']])), 'Azul');
    assert.equal(testables.resolveVendor(new Map([['IMPLEMENTOR', 'Oracle Corporation']])), 'Oracle');
    assert.equal(testables.resolveVendor(new Map([['IMPLEMENTOR', 'Amazon.com Inc.']])), 'Corretto');
    assert.equal(testables.resolveVendor(new Map()), undefined);
  });

  it('resolves the user home folder as default search root', () => {
    assert.equal(testables.resolveUserHomeDirectory('win32', { USERPROFILE: 'C:\\Users\\tester' }, 'C:\\fallback'), 'C:\\Users\\tester');
    assert.equal(testables.resolveUserHomeDirectory('linux', { HOME: '/home/tester' }, '/fallback'), '/home/tester');
    assert.equal(testables.resolveUserHomeDirectory('linux', {}, '/fallback'), '/fallback');
  });

  it('resolves settings from the active profile global storage URI', () => {
    const globalStorage = vscode.Uri.file(path.join('C:', 'Users', 'tester', 'AppData', 'Roaming', 'Code', 'User', 'profiles', 'profile-id', 'globalStorage', 'klibio.vscode-jre-config'));
    assert.equal(
      testables.normalizeFsPath(testables.resolveUserSettingsUri(globalStorage).fsPath),
      testables.normalizeFsPath(path.join('C:', 'Users', 'tester', 'AppData', 'Roaming', 'Code', 'User', 'profiles', 'profile-id', 'settings.json'))
    );
  });

  it('keeps runtime folder name when version is already present', () => {
    assert.equal(testables.buildRuntimeName('java-18-openjdk', '18.0.2'), 'java-18-openjdk');
  });

  it('appends major version when folder name does not include it', () => {
    assert.equal(testables.buildRuntimeName('jdk-lts', '21.0.2'), 'jdk-lts_21');
  });

  it('extracts legacy and modern Java major versions', () => {
    assert.equal(testables.extractJavaMajor('1.8.0_412'), '1.8');
    assert.equal(testables.extractJavaMajor('21.0.2'), '21');
  });

  it('orders newer Java versions first', () => {
    assert.ok(testables.compareJavaVersions('21.0.2', '17.0.10') < 0);
    assert.ok(testables.compareJavaVersions('17.0.10', '21.0.2') > 0);
    assert.equal(testables.compareJavaVersions('17.0.10', '17.0.10'), 0);
  });

  it('normalizes paths and skips expected directories', () => {
    assert.equal(testables.normalizeFsPath('C:/Java/JDK-21'), 'c:\\java\\jdk-21');
    assert.equal(testables.shouldSkipDirectory('node_modules'), true);
    assert.equal(testables.shouldSkipDirectory('custom-folder'), false);
  });

  it('searches common Windows installation folders for major Java vendors', () => {
    const roots = testables.getDefaultJavaSearchPaths('win32', 'C:\\Users\\tester', {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)'
    });

    for (const vendor of ['Java', 'Eclipse Adoptium', 'GraalVM', 'Azul Systems', 'Amazon Corretto']) {
      assert.ok(roots.includes(path.win32.join('C:\\Program Files', vendor)));
    }
    assert.ok(roots.includes('C:\\Users\\tester\\.jdks'));
  });

  it('searches standard macOS and Linux Java installation folders', () => {
    const macRoots = testables.getDefaultJavaSearchPaths('darwin', '/Users/tester', {});
    assert.ok(macRoots.includes('/Library/Java/JavaVirtualMachines'));
    assert.ok(macRoots.includes(path.join('/Users/tester', 'Library', 'Java', 'JavaVirtualMachines')));

    const linuxRoots = testables.getDefaultJavaSearchPaths('linux', '/home/tester', {});
    assert.ok(linuxRoots.includes('/usr/lib/jvm'));
    assert.ok(linuxRoots.includes('/opt/temurin'));
    assert.ok(linuxRoots.includes('/opt/graalvm'));
    assert.ok(linuxRoots.includes('/opt/azul'));
    assert.ok(linuxRoots.includes('/opt/amazon-corretto'));
    assert.ok(linuxRoots.includes(path.join('/home/tester', '.sdkman', 'candidates', 'java')));
  });

  it('adds runtimes from subsequent scans without duplicating existing paths', () => {
    const first = { name: 'JavaSE-17', path: 'C:/Java/jdk-17', kind: 'jdk' as const };
    const second = { name: 'JavaSE-21', path: 'C:/Java/jdk-21', kind: 'jdk' as const };
    const initial = testables.mergeRuntimeEntries([], [first]);
    const subsequent = testables.mergeRuntimeEntries(initial.merged, [first, second]);

    assert.deepEqual(subsequent.added, [second]);
    assert.deepEqual(subsequent.merged.map((runtime) => runtime.path), [first.path, second.path]);
  });

  it('refreshes existing runtime metadata without changing custom fields or defaults', () => {
    const existing = [{ name: 'JavaSE-17', path: 'C:/Java/jdk-21', label: 'old label', sources: 'C:/Java/old-src.zip', javadoc: 'C:/Java/old-docs', default: true, custom: 'keep' }];
    const discovered = [{ name: 'JavaSE-21', path: 'C:/Java/jdk-21', kind: 'jdk' as const, label: '[JDK 21] Temurin 21.0.2', sources: 'C:/Java/jdk-21/lib/src.zip' }];

    const refreshed = testables.mergeRuntimeEntries(existing, discovered);
    assert.deepEqual(refreshed.added, []);
    assert.deepEqual(refreshed.updated, discovered);
    assert.deepEqual(refreshed.merged, [{ name: 'JavaSE-21', path: existing[0].path, sources: discovered[0].sources, default: true, custom: 'keep' }]);
    assert.deepEqual(testables.mergeRuntimeEntries(refreshed.merged, discovered).updated, []);
  });

  it('syncs user runtimes to existing workspace settings without changing its default', () => {
    const workspace = [{ name: 'JavaSE-17', path: 'C:/Java/jdk-17', default: true }];
    const user = [
      { name: 'JavaSE-17', path: 'C:/Java/jdk-17' },
      { name: 'JavaSE-21', path: 'C:/Java/jdk-21', default: true }
    ];

    const merged = testables.mergeWorkspaceRuntimes(workspace, user);
    assert.deepEqual(merged, [workspace[0], { name: 'JavaSE-21', path: 'C:/Java/jdk-21' }]);
    assert.deepEqual(workspace, [{ name: 'JavaSE-17', path: 'C:/Java/jdk-17', default: true }]);
    assert.deepEqual(testables.mergeWorkspaceRuntimes(merged, user), merged);
  });

  it('refreshes workspace runtime metadata while keeping its default and workspace-specific fields', () => {
    const workspace = [{ name: 'JavaSE-17', path: 'C:/Java/jdk-21', default: true, label: 'old', javadoc: 'stale', custom: 'keep' }];
    const user = [{ name: 'JavaSE-21', path: 'C:/Java/jdk-21', label: '[JDK 21] Temurin 21.0.2', sources: 'C:/Java/jdk-21/lib/src.zip' }];
    const merged = testables.mergeWorkspaceRuntimes(workspace, user);

    assert.deepEqual(merged, [{ name: 'JavaSE-21', path: workspace[0].path, sources: user[0].sources, default: true, custom: 'keep' }]);
    assert.deepEqual(testables.mergeWorkspaceRuntimes(merged, user), merged);
  });

  it('leaves unvalidated workspace entries unchanged', () => {
    const workspace = [{ name: 'JavaSE-17', path: 'C:/Java/missing', label: 'keep me', default: true }];
    const user = [{ name: 'JavaSE-21', path: 'C:/Java/missing' }];
    assert.deepEqual(testables.mergeWorkspaceRuntimes(workspace, user, new Set()), workspace);
  });

  it('writes runtime labels as idempotent JSONC comments', () => {
    const settings = `{
  "java.configuration.runtimes": [
    {
      "name": "JavaSE-25",
      "path": "C:/Java/JAVA25"
    }
  ]
}`;
    const runtimes = new Map([
      ['c:/java/java25', { path: 'C:/Java/JAVA25', label: '[JDK 25] Azul 25.0.2+10-LTS' }]
    ]);

    const commented = testables.updateRuntimeCommentsInText(settings, ['java.configuration.runtimes'], runtimes);
    assert.match(commented, /    \/\/ \[JDK 25\] Azul 25\.0\.2\+10-LTS\n    \{/u);
    assert.equal(testables.updateRuntimeCommentsInText(commented, ['java.configuration.runtimes'], runtimes), commented);

    const refreshed = testables.updateRuntimeCommentsInText(commented, ['java.configuration.runtimes'], new Map([
      ['c:/java/java25', { path: 'C:/Java/JAVA25', label: '[JDK 25] Azul 25.0.3+1-LTS' }]
    ]));
    assert.doesNotMatch(refreshed, /25\.0\.2/u);
    assert.match(refreshed, /\/\/ \[JDK 25\] Azul 25\.0\.3\+1-LTS/u);
  });

  it('scans multiple folders and reports runtime discovery progress', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jre-config-test-'));
    try {
      const homes = [path.join(root, 'first', 'jdk-17'), path.join(root, 'second', 'jdk-21')];
      for (const [index, home] of homes.entries()) {
        await fs.mkdir(path.join(home, 'bin'), { recursive: true });
        await fs.writeFile(path.join(home, 'bin', 'java'), '');
        await fs.writeFile(path.join(home, 'release'), `JAVA_VERSION="${index === 0 ? '17.0.10' : '21.0.2'}"\n`);
      }

      const progress: Array<{ folders: number; found: number }> = [];
      const found = await testables.findJavaRuntimes([path.join(root, 'first'), path.join(root, 'second')], (folders, count) => {
        progress.push({ folders, found: count });
      });

      assert.deepEqual(found.map((runtime) => runtime.version), ['21.0.2', '17.0.10']);
      assert.ok(progress.some((entry) => entry.found === 1));
      assert.equal(progress.at(-1)?.found, 2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('follows symlinked runtime folders', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jre-config-link-'));
    try {
      const home = path.join(root, 'real', 'jdk-25');
      await fs.mkdir(path.join(home, 'bin'), { recursive: true });
      await fs.writeFile(path.join(home, 'bin', 'java'), '');
      await fs.writeFile(path.join(home, 'release'), 'JAVA_VERSION="25.0.4.1"\n');

      const linkRoot = path.join(root, 'links');
      await fs.mkdir(linkRoot, { recursive: true });
      try {
        await fs.symlink(home, path.join(linkRoot, 'JAVA25'), 'junction');
      } catch {
        this.skip();
      }

      const found = await testables.findJavaRuntimes([linkRoot]);
      assert.equal(found.length, 1);
      assert.equal(found[0].version, '25.0.4.1');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
