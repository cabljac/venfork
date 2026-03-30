# venfork

## [0.3.0](https://github.com/cabljac/venfork/compare/v0.2.0...v0.3.0) (2026-03-30)


### Features

* add org support and basic logo ([2bdff52](https://github.com/cabljac/venfork/commit/2bdff523ff7421c181b1fd59668827123f89ec55))
* add VENFORK_ORG env variable parsing ([a942e26](https://github.com/cabljac/venfork/commit/a942e268680efe5cac2413c4c401b690a7028bae))
* clone command ([7638bb5](https://github.com/cabljac/venfork/commit/7638bb5441952d3d9747e49afa66f9a03a08c36d))
* **release:** automate npm publish on release ([1cee2d8](https://github.com/cabljac/venfork/commit/1cee2d8a06cacce3acf6eeaec354b9c2c3e7e88b))
* **setup:** idempotent recovery, --fork-name, gh clone, owner/repo shorthand ([42ac888](https://github.com/cabljac/venfork/commit/42ac88846d929b51b215a2c8ca7485df0d31dcb8))


### Bug Fixes

* add trailing newline to release-please-config.json ([dd6c3a0](https://github.com/cabljac/venfork/commit/dd6c3a02983c2dd8ffb400a11b1436f421fbfef9))
* biome formatting in setup-args and tests ([afdd76d](https://github.com/cabljac/venfork/commit/afdd76d626b9ea537a87fc0c640516644efd8323))
* normalizeGithubRepoInput double .git and missing flag value validation ([856d516](https://github.com/cabljac/venfork/commit/856d51614237ad0ee0c9075ffea5dacb6efe0d96))
* reject unrecognised URL formats in normalizeGithubRepoInput ([fe3ebd3](https://github.com/cabljac/venfork/commit/fe3ebd32f7fa737e5d0bf9d5174d523654fc2429))
* **release:** add .exe extension for Windows binaries ([f331a04](https://github.com/cabljac/venfork/commit/f331a04654a5d440ffa6217d3a0ee158196e4761))
* **release:** add missing release-please manifest file ([e38be95](https://github.com/cabljac/venfork/commit/e38be955346f978c126f9d0c6c424c8e1198fbec))
* **release:** use fs.mkdir and fix biome formatting in release script ([e25433a](https://github.com/cabljac/venfork/commit/e25433ad564de99b637a9015618ff7811ca2d853))
* **release:** use import.meta.dir and rootDir for correct paths ([6759c9e](https://github.com/cabljac/venfork/commit/6759c9eff1468dab060cdf39e9c50c564ea062c4))
* **tests:** add access to node:fs/promises mock ([477e9bc](https://github.com/cabljac/venfork/commit/477e9bc4289409f9e8365a854e60f7f96565edd0))
* tighten validation for upstream input, empty flags, and same-owner fork recovery ([0aa29f3](https://github.com/cabljac/venfork/commit/0aa29f373a73194a000891735fd96f63b3088bd6))


### Performance Improvements

* optimize setup to clone only default branch and fix --org= parsing ([5263ef7](https://github.com/cabljac/venfork/commit/5263ef7bc0170376f2f27b0a5ad0973bd6d8f204))

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
