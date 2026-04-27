import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { $ } from 'execa';
import { readVenforkConfigFromRepo } from '../../src/config.js';
import {
  cleanupAll,
  createUpstreamRepo,
  dirExists,
  ensureDeleteRepoScope,
  ensureDistinctOwners,
  ensureGhAuth,
  GITHUB_ORG,
  getDefaultBranchSha,
  getPushToken,
  getRepoDefaultBranch,
  listCommitMessages,
  localMirrorPath,
  names,
  pokeUpstream,
  REPO_ROOT,
  RUN_ID,
  readWorkflowFromOrigin,
  runVenfork,
  setRepoSecret,
  tmpRoot,
  UPSTREAM_OWNER,
  waitForDispatchedRun,
  waitForRunCompletion,
} from './helpers.js';

const E2E_ENABLED = process.env.VENFORK_E2E === '1';
const REAL_DISPATCH = process.env.VENFORK_E2E_REAL_DISPATCH === '1';
const REAL_CRON = process.env.VENFORK_E2E_REAL_CRON === '1';

const e2eDescribe = E2E_ENABLED ? describe : describe.skip;

e2eDescribe('venfork e2e — scheduled sync flow', () => {
  beforeAll(async () => {
    await ensureGhAuth();
    await ensureDeleteRepoScope();
    ensureDistinctOwners();
    await fs.mkdir(tmpRoot, { recursive: true });
    await $({ cwd: REPO_ROOT, stdio: 'inherit' })`bun run build`;
    console.log(
      `[venfork-e2e] run id=${RUN_ID} upstream=${UPSTREAM_OWNER} fork-org=${GITHUB_ORG} tmp=${tmpRoot}`
    );
  });

  afterAll(async () => {
    await cleanupAll();
  });

  test('tier 1: setup → schedule → upstream poke → local sync reflects', async () => {
    // 1. Create upstream repo (under UPSTREAM_OWNER) with README so it has
    //    at least one commit and can be forked.
    await createUpstreamRepo();
    const defaultBranch = await getRepoDefaultBranch(
      UPSTREAM_OWNER,
      names.upstream
    );
    const initialUpstreamSha = await getDefaultBranchSha(
      UPSTREAM_OWNER,
      names.upstream,
      defaultBranch
    );

    // 2. Run `venfork setup`. With `--org GITHUB_ORG` (the mirror/fork org)
    //    venfork creates the fork+mirror under that org. The personal-account
    //    prompt does not fire because GITHUB_ORG !== gh user. We still pipe
    //    `y\n` defensively in case someone overrides VENFORK_E2E_ORG to
    //    match the gh user.
    await runVenfork(
      [
        'setup',
        `${UPSTREAM_OWNER}/${names.upstream}`,
        names.mirrorBare,
        '--org',
        GITHUB_ORG,
        '--fork-name',
        names.fork,
      ],
      {
        cwd: tmpRoot,
        env: { VENFORK_ORG: GITHUB_ORG },
        input: 'y\n',
      }
    );

    expect(await dirExists(localMirrorPath)).toBe(true);

    const remotes = (await $({ cwd: localMirrorPath })`git remote -v`).stdout;
    expect(remotes).toMatch(
      new RegExp(
        `origin\\s+\\S*${GITHUB_ORG}\\S*${names.mirrorBare}\\S*\\s+\\(fetch\\)`
      )
    );
    expect(remotes).toMatch(
      new RegExp(
        `public\\s+\\S*${GITHUB_ORG}\\S*${names.fork}\\S*\\s+\\(fetch\\)`
      )
    );
    expect(remotes).toMatch(
      new RegExp(
        `upstream\\s+\\S*${UPSTREAM_OWNER}\\S*${names.upstream}\\S*\\s+\\(fetch\\)`
      )
    );

    const upstreamPushUrl = (
      await $({ cwd: localMirrorPath })`git remote get-url --push upstream`
    ).stdout.trim();
    expect(upstreamPushUrl).toBe('DISABLE');

    const initialConfig = await readVenforkConfigFromRepo(localMirrorPath);
    expect(initialConfig).not.toBeNull();
    expect(initialConfig?.upstreamUrl).toContain(names.upstream);
    expect(initialConfig?.publicForkUrl).toContain(names.fork);
    expect(initialConfig?.schedule).toBeUndefined();

    // 3. Enable scheduled sync. Use */5 since GitHub Actions cron has a
    //    5-minute floor.
    const cron = '*/5 * * * *';
    await runVenfork(['schedule', 'set', cron], { cwd: localMirrorPath });

    const wf = await readWorkflowFromOrigin(localMirrorPath, defaultBranch);
    expect(wf).toContain(`cron: '${cron}'`);
    expect(wf).toContain('workflow_dispatch:');
    expect(wf).toContain('npm install -g venfork');
    expect(wf).toContain('venfork sync');

    const scheduledConfig = await readVenforkConfigFromRepo(localMirrorPath);
    expect(scheduledConfig?.schedule).toEqual({ enabled: true, cron });

    // After `schedule set`, mirror default has the +1 workflow commit but
    // public/upstream do not.
    const mirrorShaAfterSchedule = await getDefaultBranchSha(
      GITHUB_ORG,
      names.mirrorBare,
      defaultBranch
    );
    expect(mirrorShaAfterSchedule).not.toBe(initialUpstreamSha);
    const mirrorMessagesAfterSchedule = await listCommitMessages(
      GITHUB_ORG,
      names.mirrorBare,
      defaultBranch,
      2
    );
    expect(mirrorMessagesAfterSchedule[0]).toMatch(
      /scheduled sync workflow \(venfork\)/
    );

    // 4. Push a new commit to upstream.
    const pokeContent = `e2e poke ${RUN_ID} ${Date.now()}`;
    await pokeUpstream('poke.txt', pokeContent);
    const pokedUpstreamSha = await getDefaultBranchSha(
      UPSTREAM_OWNER,
      names.upstream,
      defaultBranch
    );
    expect(pokedUpstreamSha).not.toBe(initialUpstreamSha);

    // 5. Run `venfork sync` locally — exercises the full sync path with
    //    user-side credentials covering both the mirror and the public fork.
    await runVenfork(['sync'], { cwd: localMirrorPath });

    // 5a. public default branch is exactly upstream's tip.
    const publicSha = await getDefaultBranchSha(
      GITHUB_ORG,
      names.fork,
      defaultBranch
    );
    expect(publicSha).toBe(pokedUpstreamSha);

    // 5b. mirror default branch is upstream tip + one workflow commit.
    const mirrorShaFinal = await getDefaultBranchSha(
      GITHUB_ORG,
      names.mirrorBare,
      defaultBranch
    );
    expect(mirrorShaFinal).not.toBe(pokedUpstreamSha);

    const mirrorMessagesFinal = await listCommitMessages(
      GITHUB_ORG,
      names.mirrorBare,
      defaultBranch,
      2
    );
    expect(mirrorMessagesFinal[0]).toMatch(
      /scheduled sync workflow \(venfork\)/
    );
    // Second commit is the upstream poke commit.
    expect(mirrorMessagesFinal[1]).toContain('e2e poke poke.txt');

    // Parent of mirror tip equals upstream tip — proves +1 model.
    await $({ cwd: localMirrorPath })`git fetch origin ${defaultBranch}`;
    const parentSha = (
      await $({
        cwd: localMirrorPath,
      })`git rev-parse origin/${defaultBranch}^`
    ).stdout.trim();
    expect(parentSha).toBe(pokedUpstreamSha);
  }, 180_000);

  test.skipIf(!REAL_DISPATCH)(
    'tier 2: workflow_dispatch run on GHA syncs upstream change end-to-end',
    async () => {
      // Tier 1 left both repos in sync, with venfork's own workflow on
      // origin/main wired to use `secrets.VENFORK_PUSH_TOKEN || github.token`.
      // We just need to set the secret, push another upstream change, and
      // dispatch.
      const defaultBranch = await getRepoDefaultBranch(
        UPSTREAM_OWNER,
        names.upstream
      );

      // 1. Stash a push token as a repo secret on the mirror. The secret dies
      //    with the repo when afterAll runs `gh repo delete`.
      const token = await getPushToken();
      await setRepoSecret(
        GITHUB_ORG,
        names.mirrorBare,
        'VENFORK_PUSH_TOKEN',
        token
      );

      // 2. Push another change to upstream so we can prove propagation
      //    (different filename from tier 1 to keep commits distinguishable).
      const dispatchPokeContent = `dispatch ${RUN_ID} ${Date.now()}`;
      await pokeUpstream('dispatch.txt', dispatchPokeContent);
      const upstreamShaBeforeDispatch = await getDefaultBranchSha(
        UPSTREAM_OWNER,
        names.upstream,
        defaultBranch
      );

      // 3. Trigger the workflow_dispatch run.
      const dispatchedAt = new Date();
      await $`gh workflow run venfork-sync.yml --repo ${GITHUB_ORG}/${names.mirrorBare} --ref ${defaultBranch}`;

      const runId = await waitForDispatchedRun(
        GITHUB_ORG,
        names.mirrorBare,
        'venfork-sync.yml',
        dispatchedAt,
        90_000
      );
      console.log(
        `[venfork-e2e] dispatched run id=${runId}; polling for completion`
      );
      const { conclusion, url } = await waitForRunCompletion(
        GITHUB_ORG,
        names.mirrorBare,
        runId,
        300_000
      );
      if (conclusion !== 'success') {
        console.error(`[venfork-e2e] run failed; logs URL: ${url}`);
        const logs = await $({
          reject: false,
        })`gh run view ${runId} --repo ${GITHUB_ORG}/${names.mirrorBare} --log-failed`;
        console.error(`--- gh run view --log-failed ---\n${logs.stdout}`);
        if (logs.stderr) console.error(`--- stderr ---\n${logs.stderr}`);
      }
      expect(conclusion).toBe('success');

      // 4. Same git-state assertions as tier 1, against state produced by GHA.
      const publicSha = await getDefaultBranchSha(
        GITHUB_ORG,
        names.fork,
        defaultBranch
      );
      expect(publicSha).toBe(upstreamShaBeforeDispatch);

      const mirrorSha = await getDefaultBranchSha(
        GITHUB_ORG,
        names.mirrorBare,
        defaultBranch
      );
      expect(mirrorSha).not.toBe(upstreamShaBeforeDispatch);

      const mirrorMessages = await listCommitMessages(
        GITHUB_ORG,
        names.mirrorBare,
        defaultBranch,
        2
      );
      expect(mirrorMessages[0]).toMatch(/scheduled sync workflow \(venfork\)/);
      expect(mirrorMessages[1]).toContain('e2e poke dispatch.txt');
    },
    600_000
  );

  test.skipIf(!REAL_CRON)(
    'tier 2 slow: real cron firing succeeds (requires VENFORK_E2E_PAT, ≤20min)',
    async () => {
      // Implementation deferred. Same PAT setup as the dispatch test.
      // Then poll `gh run list` every 60s for up to 20 minutes for a NEW
      // scheduled (not workflow_dispatch) run with conclusion=success.
      // GHA cron is best-effort and may not fire within the cap; this test
      // is opt-in and inherently flaky.
      throw new Error(
        'tier 2 cron test not yet implemented; remove VENFORK_E2E_REAL_CRON=1 to skip'
      );
    },
    1_500_000
  );
});
