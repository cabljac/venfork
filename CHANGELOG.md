# venfork

## [0.5.0](https://github.com/cabljac/venfork/compare/v0.4.1...v0.5.0) (2026-04-27)


### Features

* **workflow:** wire VENFORK_PUSH_TOKEN for cross-repo scheduled sync ([db67940](https://github.com/cabljac/venfork/commit/db67940ef5ff9572b749bd25a60204feb61a8ea3))


### Bug Fixes

* **commands:** abort stage on evil merges outside .github/workflows ([a3d3ea6](https://github.com/cabljac/venfork/commit/a3d3ea6c6ff2537988227bf4ae1ed6e79976f108))
* **commands:** filter workflow commits in stage by identity, not position ([d8eb103](https://github.com/cabljac/venfork/commit/d8eb103a88af4097370978624c45fa7479b9a404))
* **commands:** narrow workflow-commit detection and add --topo-order ([003abb8](https://github.com/cabljac/venfork/commit/003abb85f3c6e064056a95c175f1b8eceabb0b88))
* **commands:** skip merge commits in stage cherry-pick loop ([78e8a47](https://github.com/cabljac/venfork/commit/78e8a478ed9f3fdd87bdb1e305fbd98c881d0792))
* **commands:** treat any .github/workflows commit as managed in sync divergence check ([3751e1f](https://github.com/cabljac/venfork/commit/3751e1f71d90249a6583ed37401bf4a27ea79800))
* **setup:** handle owner/repo shorthand for gh repo fork and add regression docs/tests ([4145f8e](https://github.com/cabljac/venfork/commit/4145f8eb4b8195ce242e216ae397ae63b0109991))
* **setup:** validate reused public repo is fork of upstream ([604a5cb](https://github.com/cabljac/venfork/commit/604a5cb468dd7cde0fa9ab00485f11b6c55ec6e2))
* **stage:** fail closed when merge inspection cannot read commit ([2d378c4](https://github.com/cabljac/venfork/commit/2d378c4b43e38d6ab9594d5bad0f64a57b4225a1))

## [0.4.1](https://github.com/cabljac/venfork/compare/v0.4.0...v0.4.1) (2026-04-08)


### Bug Fixes

* **README:** Clarify behavior of `venfork sync` and default branch management with scheduled sync ([1a68f0e](https://github.com/cabljac/venfork/commit/1a68f0ed9e32ea01505e4bb960d95423686b1027))

## [0.4.0](https://github.com/cabljac/venfork/compare/v0.3.0...v0.4.0) (2026-04-07)


### Features

* **commands:** Enhance sync and staging workflows by adding scheduled sync commit handling ([7213e15](https://github.com/cabljac/venfork/commit/7213e15d8bd1f129a50947c6ea023d1342d1ea81))
* configurable scheduled sync via GitHub Actions (+1 workflow commit model) ([bbc771c](https://github.com/cabljac/venfork/commit/bbc771cc2402732bfe3df9f33e98a817d4c2f696))
* **schedule:** Implement scheduled sync management and update workflow configuration ([cf7799e](https://github.com/cabljac/venfork/commit/cf7799ecb72c157b2e8477a16db515223fcaa59f))
* **workflows:** add mirror workflow allowlist controls ([35e8190](https://github.com/cabljac/venfork/commit/35e81904f837478dde13615a0793cd45bbd29f32))
* **workflows:** introduce allowlist and blocklist for workflow management ([972043a](https://github.com/cabljac/venfork/commit/972043a557d631a1f51bb10ac57df7101bd93aa7))


### Bug Fixes

* apply review feedback - workflow-only commit detection, divergence count, force-with-lease, cron YAML escaping ([9d4778d](https://github.com/cabljac/venfork/commit/9d4778dbbf3f7ef95c8a6debbcda8277d1f91b06))
* **commands, workflow:** Improve file change detection and cron string handling in workflow generation ([87f29be](https://github.com/cabljac/venfork/commit/87f29beed399a7a608de8aa95ba16b430f086bb5))
* **commands, workflow:** Remove unused import and simplify cron escaping function ([cde295e](https://github.com/cabljac/venfork/commit/cde295ec2b3d6563b78e1a284fa03fed828bd218))
* **commands:** Enhance cron expression validation and add remote branch existence check ([75b0707](https://github.com/cabljac/venfork/commit/75b0707582ca10663f929d37a70d5ffba3cba22e))
* **commands:** Update git push commands to use refs/heads for branch references ([aa98038](https://github.com/cabljac/venfork/commit/aa98038f56743babfdc3fadee93808a90c8f2c48))

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
