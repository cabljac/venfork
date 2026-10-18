# Migration

Moving a mirror between venfork versions.

## Upgrading from 0.10 or earlier

Scheduled mirrors created by 0.10 or earlier run an unpinned `npm install -g venfork`. Once 0.11 is on npm, a scheduled run installs it, sees the unpinned workflow and stops with the migration message. It does not rewrite the managed commit. Every scheduled run fails the same way until you migrate the mirror locally:

1. Install venfork 0.11 or later locally: the released version from npm, or the release tarball.
2. Create `VENFORK_PUSH_TOKEN` on the mirror (see "Authenticating cross-repo pushes" in [scheduled-sync.md](scheduled-sync.md)). The new workflow needs it in both modes.
3. In a clone of the mirror, run `venfork sync` once. The pinned workflow lands on the default branch, so later runs install exactly that version.

The next scheduled run then succeeds and closes the `venfork-sync-blocked` issue. `venfork doctor` reports an unmigrated mirror on its `workflow` check.
