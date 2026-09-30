# Development

## Prerequisites

- VS Code 1.100 or newer. Ensure `code --version` prints a version before using the CLI steps below. On this Windows installation, use `C:/idefix/apps/VSCode/bin/code`; `C:/idefix/apps/VSCode/Code.exe` is the GUI executable and does not process CLI arguments correctly.
- Node.js and npm compatible with the versions required by `package.json` (Node.js 20 or newer).
- A locally installed JDK or JRE for manual scanning. The Java extension is useful for checking how `java.configuration.runtimes` is consumed, but is not required to build this extension.
- Access to download VS Code for `npm test` if the test runner cannot find a local VS Code executable.

## Develop

From the repository root:

```sh
npm ci
npm run compile
```

Edit `src/extension.ts` and add or update cases in `src/test/suite/extension.test.ts`. Run `npm run watch` during development to recompile TypeScript on changes. Generated JavaScript goes into `dist/`.

For code or behavior changes, increment the semantic version in `package.json` (and update the lockfile) and add an entry to `CHANGELOG.md`.

## Test Locally

1. Run `npm test` from the repository root. It compiles the project, then runs the Mocha extension suite in a VS Code test instance. Set `VSCODE_EXECUTABLE_PATH` to your VS Code executable if the runner cannot find one; otherwise it may download a test instance.
2. Run `npm run compile`, close any previous Extension Development Host, then launch a new one from Git Bash:

	```sh
	"/c/idefix/apps/VSCode/bin/code" \
	  --extensionDevelopmentPath="C:/git/github.com/peterkir/vscode-jre-config" \
	  --new-window "C:/git/github.com/klibio/example.bnd.rcp/"
	```

	The example folder's `.vscode/settings.json` makes it a folder workspace but does not control which extension version runs. Open **Developer: Show Running Extensions** and confirm Java Runtime Configurator shows the version from this repository's `package.json`, not the installed Marketplace version. Run **Java Runtimes: Scan Folders and Configure** from the Command Palette and choose a folder containing a locally installed JDK or JRE. Inspect the Java Runtime Configurator output channel and `java.configuration.runtimes` in user and workspace settings. Repeat the command after changing a Java installation's `release` file to confirm existing labels and versions refresh; configured paths that no longer contain Java are reported but retained. Recompile and restart the development host after code changes.
3. Run `npm run package` to compile and create a versioned `.vsix` file. To test the distributable before publishing, install it in a separate VS Code profile with `"/c/idefix/apps/VSCode/bin/code" --profile "JRE Config Test" --install-extension <generated-file>.vsix`, then open the example workspace with `"/c/idefix/apps/VSCode/bin/code" --profile "JRE Config Test" --new-window "C:/git/github.com/klibio/example.bnd.rcp/"` and repeat the scan. Do not publish until both `npm run compile` and `npm run package` succeed.

## Publish

1. Ensure you have access to the `klibio` publisher in the [Visual Studio Marketplace publisher portal](https://marketplace.visualstudio.com/manage). Create an Azure DevOps personal access token with the **Marketplace (Manage)** scope. Keep the token private; do not commit it.
2. Increment `version` in `package.json` and `package-lock.json`, and add a matching entry to `CHANGELOG.md`. A version already published to the Marketplace cannot be published again.
3. From the repository root, verify and package the release:

	```sh
	npm ci
	npm test
	npm run compile
	npm run package
	```

4. Authenticate once (enter the token at the prompt), then publish the version in `package.json`:

	```sh
	npx @vscode/vsce login klibio
	npx @vscode/vsce publish
	```

5. Confirm the new version appears on the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=klibio.vscode-jre-config).