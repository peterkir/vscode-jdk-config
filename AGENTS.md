# AGENTS

## Project Guardrails

- Treat this repository as a VS Code extension project and preserve extension compatibility.
- Any change to code or functionality requires a semantic version increment in `package.json` and a corresponding entry in `CHANGELOG.md`.
- For any code or configuration change, validate the project builds successfully.
- Required validation commands after every change:
  - `npm run compile`
  - `npm run package`
- A change is not complete unless both commands succeed.
- If either command fails, fix the issue before considering the task done.

## Implementation Notes

- Keep changes minimal and focused on the user request.
- Do not break extension manifest compatibility in `package.json`.
- Maintain valid TypeScript and keep generated output in a packageable state.
