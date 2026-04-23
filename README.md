# Java Runtime Configurator

A Visual Studio Code extension that helps you discover Java runtimes and add them to the VS Code Java runtime configuration.

## Requirements

- VS Code 1.100 or newer
- The Java extension reads and uses `java.configuration.runtimes`
- Access to the local filesystem where JDKs or JREs are installed

## Command

- Java Runtimes: Scan Folders and Configure

## What It Does

- Prompts for one or more root folders.
- Scans recursively for Java installations.
- Uses the runtime root folder name as the `name` value.
- If the folder name does not contain the detected Java version, appends `_<version>`.
- Adds discovered Java homes to the `java.configuration.runtimes` setting.
- Adds `sources` and `javadoc` when those paths are detected.
- Prompts for which runtime should be the default for the current workspace and stores it in workspace settings.

## How It Works

1. Run the command from the Command Palette.
2. Select one or more root folders to scan.
3. The extension searches recursively for directories that contain `bin/java` or `bin/java.exe`.
4. If `javac` is present, the runtime is treated as a JDK; otherwise it is treated as a JRE.
5. New runtimes are appended to `java.configuration.runtimes` in user settings.
6. You are prompted to choose which runtime should be the default for the current workspace.

## Runtime Naming Rules

- The runtime `name` starts with the Java home folder name.
- If the detected Java version is already contained in the folder name, the folder name is used as-is.
- If the version is missing from the folder name, the extension appends `_<version>`.
- If sources or javadoc are found, they are added to the runtime entry.

## Example Workflow

1. Open the Command Palette.
2. Run `Java Runtimes: Scan Folders and Configure`.
3. Select a folder such as `/usr/lib/jvm` or `C:\Java`.
4. Review the detected runtimes.
5. Choose the default runtime for the current workspace when prompted.

## Example Runtime Entry

```json
"java.configuration.runtimes": [
	{
		"name": "java-18-openjdk",
		"path": "/usr/lib/jvm/java-18-openjdk",
		"sources": "/usr/lib/jvm/java-18-openjdk/lib/src.zip",
		"javadoc": "/usr/share/javadoc/java-18-openjdk/api",
		"default": true
	}
]
```

## Limitations

- The extension is intended for local filesystem runtimes.
- Virtual workspaces are not supported.
- Existing runtime entries are preserved and not rewritten unless the same path is newly added.

## Development

- Install dependencies: `npm install`
- Build: `npm run compile`
- Run tests: `npm test`
- Package VSIX: `npm run package`

## Testing

The repository includes a VS Code extension test runner based on `@vscode/test-electron` and Mocha. The test suite validates command registration and the runtime naming/version helper logic.

## Troubleshooting

- If no runtimes are found, verify the selected directory contains JDK or JRE installations with `bin/java`.
- If sources or javadoc are missing, verify the runtime installation includes `lib/src.zip`, `docs/api`, `javadoc/api`, or a matching shared javadoc directory.
- If packaging fails, run `npm run compile` first and confirm the repository is in a packageable state.

## License

EPL-2.0
