import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { testables } from '../../extension';

describe('Extension Test Suite', () => {
  it('registers scan command', async () => {
    const extension = vscode.extensions.getExtension('local.vscode-jre-config');
    assert.ok(extension);
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('vscode-jre-config.scanJavaRuntimes'));
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
});
