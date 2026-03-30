# Contributing to VisTracer

Thank you for your interest in contributing. This document covers how to get set up, the conventions used, and the process for submitting changes.

## Prerequisites

- Node.js 22 or later
- npm (bundled with Node.js)
- macOS, Linux, or Windows
- (Optional) MaxMind GeoLite2 `.mmdb` files for local geo enrichment during development

## Development Setup

```bash
# Clone the repository
git clone https://github.com/rush-skills/vistracer.git
cd vistracer

# Install dependencies
npm install

# Start the development environment (main process compiler + Vite dev server + Electron)
npm run dev
```

The `dev` script runs three processes concurrently: the TypeScript compiler for the main process, the Vite dev server for the renderer, and Electron itself. Changes to the renderer reload automatically via HMR; changes to the main process require restarting `npm run dev`.

## Project Architecture

See [CLAUDE.md](./CLAUDE.md) for a detailed description of the process architecture, IPC communication flow, traceroute pipeline, globe visualization, and state management.

## Code Style

The project uses **Prettier** for formatting and **ESLint** for linting.

```bash
# Lint all source files
npm run lint

# Type-check both main and renderer processes
npm run typecheck
```

Before opening a pull request, make sure both commands exit cleanly. Formatting is enforced by Prettier; run your editor's format-on-save or invoke Prettier directly if needed. Do not disable ESLint rules inline without a clear comment explaining why.

Key conventions:

- TypeScript strict mode is enabled — avoid `any` and non-null assertions unless genuinely necessary.
- Shared types between the main and renderer processes live in `src/common/`. Do not import renderer code from the main process or vice versa outside of `src/common/`.
- Path aliases (`@common/`, `@renderer/`, `@assets/`) are configured in `tsconfig.base.json`; use them instead of deep relative imports.
- Keep IPC channel additions in `src/common/ipc.ts` and update `src/common/bridge.ts` and `src/main/preload.ts` together.

## Testing

Tests use **Vitest** with Testing Library (renderer-focused). Tests live alongside the code they cover under `__tests__/` directories.

```bash
# Run all tests once
npm run test

# Run tests in watch mode during development
npm run test:watch
```

All new features and bug fixes should include a corresponding test. Renderer tests run in a jsdom environment. Main-process tests run in a Node environment but require mocking `electron` and `electron-store` via `vi.mock()` (see existing test files for the pattern using `vi.hoisted()` to avoid hoisting issues).

## Building for Production

```bash
npm run build
npm run start   # Launch the production build locally
```

Electron Forge is used for packaging. Do not commit built artifacts.

## Pull Request Workflow

1. Fork the repository and create a branch from `main`:
   ```
   git checkout -b fix/your-topic
   ```
2. Make your changes, following the code style and testing guidelines above.
3. Ensure `npm run lint`, `npm run typecheck`, and `npm run test` all pass.
4. Open a pull request against `main` on `rush-skills/vistracer`. Fill in the pull request template completely.
5. A maintainer will review your PR. Please respond to review comments promptly and push fixup commits rather than force-pushing during an active review.
6. Once approved, a maintainer will merge using squash-and-merge to keep the history clean.

## Reporting Issues

Use the GitHub issue templates for [bug reports](https://github.com/rush-skills/vistracer/issues/new?template=bug_report.md) and [feature requests](https://github.com/rush-skills/vistracer/issues/new?template=feature_request.md).

## License

By contributing, you agree that your contributions will be licensed under the MIT License that covers this project.
