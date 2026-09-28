# Java Runtime Configurator

A Visual Studio Code extension that helps you discover Java runtimes and add them to the VS Code Java runtime configuration.

## Requirements

- VS Code 1.100 or newer
- The Java extension reads and uses `java.configuration.runtimes`
- Access to the local filesystem where JDKs or JREs are installed

## Command

- Java Runtimes: Scan Folders and Configure

## What It Does

- Asks whether to scan common Java installation locations for your OS or choose one or more folders manually.
- Scans recursively for Java installations.
- Uses the detected Java version for the canonical execution environment `name` (for example, `JavaSE-21`).
- Keeps the runtime folder name in `label`, appending `_<version>` when the folder name does not include the major version.
- Adds discovered Java homes to the `java.configuration.runtimes` setting.
- Adds `sources` and `javadoc` when those paths are detected.
- Prompts for which runtime should be the default for the current workspace and stores it in workspace settings.
- Repeated scans add new runtimes without removing previous ones; existing workspace defaults are retained if selection is canceled.
- Shows folder and runtime counts while scanning, then lists versions and added/already-present status in the Java Runtime Configurator output channel.

## How It Works

1. Run the command from the Command Palette.
2. Choose common OS installation locations or select one or more folders manually.
3. The extension searches recursively for directories that contain `bin/java` or `bin/java.exe`.
4. If `javac` is present, the runtime is treated as a JDK; otherwise it is treated as a JRE.
5. New runtimes are appended to `java.configuration.runtimes` in user settings.
6. You are prompted to choose which runtime should be the default for the current workspace.

## Runtime Naming Rules

- The runtime `name` is a standard execution environment ID, such as `JavaSE-18` (or `J2SE-1.5` for Java 1.5).
- The `label` preserves the Java home folder name; if it lacks the major version, the extension appends `_<version>`.
- If sources or javadoc are found, they are added to the runtime entry.

## Example Workflow

1. Open the Command Palette.
2. Run `Java Runtimes: Scan Folders and Configure`.
3. Scan common locations (Oracle, Temurin, GraalVM, Azul, and Amazon Corretto), or select a folder such as `/usr/lib/jvm` or `C:\Java`.
4. Review the detected runtimes.
5. Choose the default runtime for the current workspace when prompted.

## Example Settings

After selecting a workspace default, the workspace settings contain the complete runtime list with `default` set on the selected entry:

```json
{
	"java.configuration.runtimes": [
		{
			"name": "JavaSE-18",
			"label": "java-18-openjdk",
			"path": "/usr/lib/jvm/java-18-openjdk",
			"sources": "/usr/lib/jvm/java-18-openjdk/lib/src.zip",
			"javadoc": "/usr/share/javadoc/java-18-openjdk/api",
			"default": true
		}
	]
}
```

The entry is also added to user settings without `default`; `sources` and `javadoc` appear only when found.

## Limitations

- The extension is intended for local filesystem runtimes.
- Common-location scanning checks existing standard vendor installation folders under Program Files on Windows, JavaVirtualMachines on macOS, and JVM/vendor folders on Linux. Use manual selection for nonstandard locations.
- Virtual workspaces are not supported.
- Existing runtime entries are preserved and not rewritten unless the same path is newly added.

## Development

- Install dependencies: `npm install`
- Build: `npm run compile`
- Run tests: `npm test`
- Package VSIX: `npm run package`

## Publishing

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

5. Confirm the new version appears on the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=klibio.vscode-jre-config). `npm run package` also creates a local versioned VSIX for inspection before publishing.

## Testing

The repository includes a VS Code extension test runner based on `@vscode/test-electron` and Mocha. The test suite validates command registration and the runtime naming/version helper logic.

## Troubleshooting

- If no runtimes are found, verify the selected directory contains JDK or JRE installations with `bin/java`.
- If sources or javadoc are missing, verify the runtime installation includes `lib/src.zip`, `docs/api`, `javadoc/api`, or a matching shared javadoc directory.
- If packaging fails, run `npm run compile` first and confirm the repository is in a packageable state.

## License

EPL-2.0
