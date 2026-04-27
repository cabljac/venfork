# Contributing to Venfork

Thank you for your interest in contributing to Venfork! This guide will help you get started.

## Development Setup

### Prerequisites

- **Node.js 18+** or **Bun** (recommended for faster development)
- **GitHub CLI (`gh`)** installed and authenticated
- **Git** configured with SSH keys

### Getting Started

1. **Fork and clone the repository**
   ```bash
   git clone https://github.com/YOUR_USERNAME/venfork.git
   cd venfork
   ```

2. **Install dependencies**
   ```bash
   bun install
   # or
   npm install
   ```

3. **Link for local testing**
   ```bash
   bun link
   # or
   npm link
   ```

4. **Run in development mode**
   ```bash
   bun run dev setup --help
   # or
   npm run dev setup --help
   ```

## Development Workflow

### Running Tests

```bash
# Run all tests
bun test
# or
npm test

# Run tests in watch mode
bun run test:watch
# or
npm run test:watch
```

**Important**: All tests must pass before submitting a PR.

### Code Quality

We use [Biome](https://biomejs.dev/) for formatting and linting.

```bash
# Format code
bun run format
# or
npm run format

# Check and fix all issues (format + lint)
bun run check
# or
npm run check

# Check formatting only (used in CI)
bun run format:check
# or
npm run format:check
```

**Before committing**: Always run `bun run check` to ensure code quality.

### Building

```bash
bun run build
# or
npm run build
```

The built files will be in the `dist/` directory.

## Project Structure

```
venfork/
├── src/
│   ├── index.ts       # CLI entry point
│   ├── commands.ts    # Command implementations
│   ├── git.ts         # Git/GitHub utilities
│   ├── utils.ts       # Pure utility functions
│   └── errors.ts      # Custom error types
├── tests/
│   ├── git.test.ts
│   ├── utils.test.ts
│   └── errors.test.ts
└── dist/              # Built output (gitignored)
```

## Making Changes

### 1. Create a Feature Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/bug-description
```

### 2. Write Code

- Follow TypeScript strict mode conventions
- Add JSDoc comments for public functions
- Keep functions small and focused
- Use descriptive variable names

### 3. Write Tests

- Write tests for new features in the appropriate test file
- Use `test` (not `it`) for test blocks (project convention)
- Ensure all tests pass: `bun test`

Example:
```typescript
test('descriptive test name', async () => {
  const result = await yourFunction();
  expect(result).toBe(expected);
});
```

### 4. Use Conventional Commit Messages

We use [release-please](https://github.com/googleapis/release-please) to drive
versioning and the changelog. It reads commit subjects on `main` and opens a
release PR that bumps `package.json`, regenerates `CHANGELOG.md`, and tags the
release. **You don't add a changeset file** — the version bump is derived from
your commit prefix:

- `fix:` → patch bump
- `feat:` → minor bump
- `feat!:` / `BREAKING CHANGE:` in the body → major bump
- `docs:`, `test:`, `refactor:`, `chore:` → no version bump

Use a scope when it adds clarity (e.g. `feat(workflow): …`, `fix(setup): …`).
The commit subject becomes the CHANGELOG entry, so write it for end users.

### 5. Run Quality Checks

```bash
# Run all checks
bun run check && bun test && bun run build

# or with npm
npm run check && npm test && npm run build
```

All must pass before submitting a PR.

### 6. Commit Your Changes

```bash
git add .
git commit -m "feat: add new feature"
# or
git commit -m "fix: resolve issue with X"
```

The commit prefix drives the release flow (see step 4).

### 7. Push and Create a Pull Request

```bash
git push origin feature/your-feature-name
```

Then create a PR on GitHub with:
- Clear title describing the change
- Description of what changed and why
- Link to any related issues
- Screenshots/examples if applicable

## Pull Request Guidelines

### Before Submitting

- ✅ All tests pass (`bun test`)
- ✅ Code is formatted and linted (`bun run check`)
- ✅ Build succeeds (`bun run build`)
- ✅ Commit subject uses a [conventional prefix](#4-use-conventional-commit-messages) so release-please picks it up
- ✅ Documentation updated if needed
- ✅ No unnecessary dependencies added

### PR Description Should Include

1. **What changed**: Brief summary of the changes
2. **Why**: Reason for the change
3. **How to test**: Steps to verify the change works
4. **Breaking changes**: Note any breaking changes (rare)

### Review Process

- Maintainers will review your PR
- Address any feedback or requested changes
- Once approved, your PR will be merged
- Your changes will be included in the next release

## Code Style Guidelines

### TypeScript

- Use strict mode (already configured)
- Avoid `any` types unless absolutely necessary
- Prefer `async/await` over callbacks
- Use descriptive type names

### Error Handling

- Use custom error types from `src/errors.ts`
- Create new error types for new error cases
- Provide helpful error messages

Example:
```typescript
if (!isValid) {
  throw new CustomError('Clear description of what went wrong');
}
```

### Git Operations

- Use functions from `src/git.ts` for git/GitHub operations
- Always use `{ reject: false }` with execa for commands that might fail
- Check exit codes for validation

### CLI Output

- Use `@clack/prompts` for all CLI interactions
- Follow the existing patterns:
  - `p.intro()` - Start of command
  - `p.spinner()` - Long-running operations
  - `p.note()` - Display information
  - `p.outro()` - End of command

## Testing Guidelines

- **Unit tests**: Test individual functions in isolation
- **Integration tests**: Test git operations (may run actual git commands)
- **Keep tests fast**: Avoid unnecessary delays
- **Clear test names**: Use descriptive test names that explain what's being tested

## Releasing (Maintainers Only)

Releases are automated by [release-please](https://github.com/googleapis/release-please) (see `.github/workflows/release.yml` and `release-please-config.json`).

### How it works

1. Every push to `main` triggers `release-please-action`. It scans new conventional-commit subjects since the last release and either opens or updates a "release PR" titled `chore(main): release X.Y.Z`.
2. The release PR contains the bumped version in `package.json`, the new section in `CHANGELOG.md`, and `.release-please-manifest.json` updated. Review and merge it when you're ready to ship.
3. Merging the release PR creates the git tag (e.g. `v0.5.0`) and triggers the npm publish + binary release jobs in the same workflow.

### Maintainer responsibilities

- Make sure commits landing on `main` use conventional prefixes (otherwise the release PR won't include them in the changelog).
- Review the open release PR before merging — confirm version + changelog look right.
- Don't manually edit `package.json` version or `CHANGELOG.md`; release-please owns both.

### Versioning Strategy

While in `0.x.x`:
- **patch** (0.0.1 → 0.0.2): Bug fixes, small improvements
- **minor** (0.1.0 → 0.2.0): New features, larger changes
- Breaking changes are OK in minor versions (API not yet stable)

After `1.0.0`:
- **patch** (1.0.0 → 1.0.1): Bug fixes only
- **minor** (1.0.0 → 1.1.0): New features, backwards compatible
- **major** (1.0.0 → 2.0.0): Breaking changes required

## Need Help?

- **Questions**: Open a [GitHub Discussion](https://github.com/cabljac/venfork/discussions)
- **Bugs**: Open an [Issue](https://github.com/cabljac/venfork/issues)
- **Feature Requests**: Open an [Issue](https://github.com/cabljac/venfork/issues) with the "enhancement" label

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to Venfork! 🎉
