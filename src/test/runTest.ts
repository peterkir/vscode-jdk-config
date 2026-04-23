import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../..');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const vscodeExecutablePath = await resolveVsCodeExecutablePath();

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
      launchArgs: [
        path.resolve(extensionDevelopmentPath, '.vscode-test-workspace'),
        '--disable-extensions',
        '--disable-workspace-trust'
      ]
    });
  } catch (error) {
    console.error('Failed to run extension tests.');
    console.error(error);
    process.exit(1);
  }
}

async function resolveVsCodeExecutablePath(): Promise<string | undefined> {
  const candidates = [
    process.env.VSCODE_EXECUTABLE_PATH,
    process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe') : undefined,
    process.platform === 'win32' ? 'C:/idefix/apps/VSCode/Code.exe' : undefined,
    process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Electron' : undefined,
    process.platform !== 'win32' && process.platform !== 'darwin' ? '/usr/share/code/code' : undefined,
    process.platform !== 'win32' && process.platform !== 'darwin' ? '/snap/code/current/usr/share/code/code' : undefined,
    path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'Code.exe' : 'code')
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  if (process.platform === 'win32') {
    const userProfile = process.env.USERPROFILE ?? os.homedir();
    const vscodeInUserApps = path.join(userProfile, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe');
    if (await pathExists(vscodeInUserApps)) {
      return vscodeInUserApps;
    }
  }

  return undefined;
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

void main();
