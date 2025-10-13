# venfork

## 0.2.0

### Minor Changes

- [`61a2e54`](https://github.com/cabljac/venfork/commit/61a2e5454dbb04d089898ab2837e0f247954c3f8) Thanks [@cabljac](https://github.com/cabljac)! - Performance improvements and bug fixes:

  - **Faster setup**: Changed from full repository mirror to cloning only the default branch, dramatically reducing setup time for large repositories
  - **Fixed argument parsing**: Now supports both `--org value` and `--org=value` formats for the organization flag

## 0.1.1

### Patch Changes

- Update README documentation to reflect v0.1.0 changes - update all examples from `-vendor` to `-private` suffix and document new venfork-config branch feature

## 0.1.0

### Minor Changes

- **New Features:**

  - Add venfork-config branch for reliable clone detection - stores publicForkUrl and upstreamUrl in `.venfork/config.json` on a dedicated orphan branch
  - Clone command now reads config first, falling back to auto-detection if not found

  **Improvements:**

  - Change default suffix from `-vendor` to `-private` for private mirror repositories
  - Fix personal account handling - passing `--org` with your personal username now works correctly
  - Improve setup prompts to only ask for missing values instead of always prompting

  **Bug Fixes:**

  - Fix GitHub API error when using personal account with `--org` flag
  - Fix redundant upstream URL prompt when provided as command argument

### Patch Changes

- [`86a246b`](https://github.com/cabljac/venfork/commit/86a246b5bf9c39463854c45d514d3e8edce6df38) Thanks [@cabljac](https://github.com/cabljac)! - Initial release of venfork - Create and manage private mirrors for vendor development workflows. Includes setup, sync, stage, and status commands.

## 0.0.1

### Patch Changes

- Initial release of venfork - a tool to manage private mirrors for vendor development
