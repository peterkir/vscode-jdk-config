# Copilot Instructions

This repository is a VS Code extension and all changes must remain package-ready.

## Mandatory Validation Workflow

1. Make the requested change.
2. Run `npm run compile`.
3. Run `npm run package`.
4. Only consider work complete when both commands pass.

## Quality Requirements

- Keep the extension behavior consistent with VS Code extension conventions.
- Avoid introducing TypeScript errors or invalid extension metadata.
- If build or package fails, fix forward immediately and re-run validation.
