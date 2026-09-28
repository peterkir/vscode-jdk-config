# Changelog

All notable changes to this project are documented in this file.

## 0.6.1

- Added a white background and subtle border to the extension icon for readability in light and dark themes.

## 0.6.0

- Added a choice to scan common OS Java installation locations or select folders manually, covering Oracle, Temurin, GraalVM, Azul, and Amazon Corretto installations.

## 0.5.0

- Preserve user and workspace runtime lists across repeated scans of different folders, including when the default picker is canceled.
- Show discovered Java versions, paths, and added/already-present status in the output channel.
- Show live folder and runtime counts while scanning.

## 0.4.1

- Changed the VS Code Marketplace publisher to `klibio`.
- Synchronized the package lockfile version with the extension manifest.

## 0.4.0

- Changed runtime configuration `name` to emit standard Eclipse Execution Environment IDs (`JavaSE-11`, `JavaSE-17`, `JavaSE-21`, etc.) to pass Red Hat Java language server validation.
- Added descriptive `label` property on runtime entries to preserve folder and VM variant details (e.g., `JAVA21-JAVAFX`).
- Updated workspace default runtime QuickPick to show both distinctive label and standard execution environment ID.

## 0.1.0

- Initial extension scaffolding.
- Added packaging scripts and VSIX build flow.
- Added extension metadata and packaging best-practice fields.
