import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { $ } from 'execa';
import { readVenforkConfigFromRepo } from '../../src/config.js';
import {
  cleanupAll,
  createIssueOnRepo,
  createUpstreamRepo,
  dirExists,
  ensureDeleteRepoScope,
  ensureDistinctOwners,
  ensureGhAuth,
  GITHUB_ORG,
  getDefaultBranchSha,
  getIssueMeta,
  getPrMeta,
  getPushToken,
  getRepoDefaultBranch,
  listCommitMessages,
  listOpenIssuesWithLabel,
  localMirrorPath,
  names,
  openUpstreamPr,
  packCodeUnderTest,
  pokeUpstream,
  publishTarballOnUpstream,
  pushToUpstreamPrBranch,
  REPO_ROOT,
  RUN_ID,
  readWorkflowFromOrigin,
  runVenfork,
  setRepoSecret,
  setRepoVariable,
  tmpRoot,
  UPSTREAM_OWNER,
  waitForDispatchedRun,
  waitForRunCompletion,
} from './helpers.js';

const E2E_ENABLED = process.env.VENFORK_E2E === '1';
const REAL_DISPATCH = process.env.VENFORK_E2E_REAL_DISPATCH === '1';

const e2eDescribe = E2E_ENABLED ? describe : describe.skip;

let installUrlPromise: Promise<string> | undefined;

/** Publishes the code under test once per run and returns its install URL. */
function codeUnderTestUrl(): Promise<string> {
  installUrlPromise ??= packCodeUnderTest().then(publishTarballOnUpstream);
  return installUrlPromise;
}

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
    expect(wf).toContain('SPEC="${VENFORK_INSTALL_SPEC:-venfork@');
    expect(wf).toContain('npm install -g --ignore-scripts "$SPEC"');
    expect(wf).toContain('- name: Check VENFORK_PUSH_TOKEN');
    expect(wf).not.toContain('|| github.token');
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
    expect(mirrorMessagesAfterSchedule[0]).toBe(
      'chore: venfork-managed mirror commit'
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
    expect(mirrorMessagesFinal[0]).toBe('chore: venfork-managed mirror commit');
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
      // We set the secret, point the install step at the code under test,
      // push another upstream change, and dispatch.
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

      // The published venfork lags this checkout, so install the build
      // from beforeAll through the workflow's VENFORK_INSTALL_SPEC override.
      const installUrl = await codeUnderTestUrl();
      await setRepoVariable(
        GITHUB_ORG,
        names.mirrorBare,
        'VENFORK_INSTALL_SPEC',
        installUrl
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
      expect(mirrorMessages[0]).toBe('chore: venfork-managed mirror commit');
      expect(mirrorMessages[1]).toContain('e2e poke dispatch.txt');

      expect(
        await listOpenIssuesWithLabel(
          GITHUB_ORG,
          names.mirrorBare,
          'venfork-sync-blocked'
        )
      ).toEqual([]);
    },
    600_000
  );

  test('tier 3: stage --pr opens upstream PR with internal body redacted', async () => {
    const defaultBranch = await getRepoDefaultBranch(
      UPSTREAM_OWNER,
      names.upstream
    );
    const featureBranch = `feat-${RUN_ID}`;

    // Create a feature branch on the local mirror clone with one commit.
    await $({
      cwd: localMirrorPath,
    })`git checkout -b ${featureBranch}`;
    await fs.writeFile(`${localMirrorPath}/feature.txt`, `feature ${RUN_ID}\n`);
    await $({
      cwd: localMirrorPath,
    })`git -c user.name=e2e -c user.email=e2e@local add feature.txt`;
    await $({
      cwd: localMirrorPath,
    })`git -c user.name=e2e -c user.email=e2e@local commit -m ${'feat: add feature.txt'}`;
    await $({ cwd: localMirrorPath })`git push origin ${featureBranch}`;

    // Open an internal review PR on the mirror with body containing a
    // redaction block.
    const internalBody = [
      'Public summary: adds feature.txt to demonstrate ship.',
      '',
      '<!-- venfork:internal -->',
      'Internal note: client X requires this for compliance ticket Z.',
      '<!-- /venfork:internal -->',
      '',
      'Implementation notes intended for upstream maintainers.',
    ].join('\n');
    await $`gh pr create --repo ${GITHUB_ORG}/${names.mirrorBare} --base ${defaultBranch} --head ${featureBranch} --title ${'feat: add feature.txt'} --body ${internalBody}`;

    // Drive `venfork stage --pr`, auto-confirming via env var (clack's
    // confirm doesn't reliably accept piped `y\n` in non-TTY mode).
    await runVenfork(['stage', featureBranch, '--pr', '--draft'], {
      cwd: localMirrorPath,
      env: { VENFORK_NONINTERACTIVE: '1' },
    });

    // Find the upstream PR. gh's --head filter on cross-repo PRs is
    // unreliable, so list all PRs and filter by headRefName in JS.
    const list =
      await $`gh pr list --repo ${UPSTREAM_OWNER}/${names.upstream} --state all --json number,url,body,isDraft,headRefName,headRepositoryOwner --limit 20`;
    const prs = JSON.parse(list.stdout) as Array<{
      number: number;
      url: string;
      body: string;
      isDraft: boolean;
      headRefName: string;
      headRepositoryOwner?: { login: string };
    }>;
    const upstreamPr = prs.find(
      (pr) =>
        pr.headRefName === featureBranch &&
        (pr.headRepositoryOwner?.login ?? '') === GITHUB_ORG
    );
    expect(upstreamPr).toBeDefined();
    if (!upstreamPr) return;
    expect(upstreamPr.body).not.toContain('Internal note');
    expect(upstreamPr.body).not.toContain('venfork:internal');
    expect(upstreamPr.body).toContain('Public summary');
    // The private mirror must stay invisible to upstream: no back-link to the
    // internal review PR and no hint that one exists.
    expect(upstreamPr.body).not.toContain('Upstreamed from internal');
    expect(upstreamPr.body).not.toContain(names.mirrorBare);
    expect(upstreamPr.isDraft).toBe(true);
  }, 300_000);

  test('tier 4: pull pr imports an upstream PR; sync refreshes it', async () => {
    const defaultBranch = await getRepoDefaultBranch(
      UPSTREAM_OWNER,
      names.upstream
    );

    // Open a PR on upstream by creating a branch directly there.
    const upstreamPrBranch = `upstream-feat-${RUN_ID}`;
    const opened = await openUpstreamPr({
      branch: upstreamPrBranch,
      filename: `upstream-${RUN_ID}.md`,
      content: `original content ${RUN_ID}\n`,
      title: `e2e upstream PR ${RUN_ID}`,
      body: 'Body of an upstream PR for e2e.',
      base: defaultBranch,
    });

    // Pull it into the mirror.
    await runVenfork(['pull', 'pr', String(opened.number)], {
      cwd: localMirrorPath,
    });

    // Verify the local + mirror branch exist with the imported head.
    const localBranch = `upstream-pr/${opened.number}`;
    const initialLocalHead = (
      await $({
        cwd: localMirrorPath,
      })`git rev-parse ${localBranch}`
    ).stdout.trim();
    const mirrorHead = await getDefaultBranchSha(
      GITHUB_ORG,
      names.mirrorBare,
      localBranch
    );
    expect(mirrorHead).toBe(initialLocalHead);

    // Update the upstream PR with another commit.
    await pushToUpstreamPrBranch({
      branch: upstreamPrBranch,
      filename: `upstream-${RUN_ID}.md`,
      content: `updated content ${RUN_ID}\n`,
    });

    // venfork sync <branch> should refresh the local + mirror branch.
    await runVenfork(['sync', localBranch], { cwd: localMirrorPath });

    const refreshedLocalHead = (
      await $({
        cwd: localMirrorPath,
      })`git rev-parse ${localBranch}`
    ).stdout.trim();
    expect(refreshedLocalHead).not.toBe(initialLocalHead);
    const refreshedMirrorHead = await getDefaultBranchSha(
      GITHUB_ORG,
      names.mirrorBare,
      localBranch
    );
    expect(refreshedMirrorHead).toBe(refreshedLocalHead);
  }, 300_000);

  test('tier 5: stage issue + pull issue round-trip through gh', async () => {
    // Create an internal issue on the mirror with a redaction block.
    const internalBody = [
      'Public bug summary: feature.txt does not load in Safari.',
      '',
      '<!-- venfork:internal -->',
      'Client X needs a fix before launch on date Y.',
      '<!-- /venfork:internal -->',
    ].join('\n');
    const internal = await createIssueOnRepo({
      owner: GITHUB_ORG,
      repo: names.mirrorBare,
      title: 'Bug: Safari rendering',
      body: internalBody,
    });

    // Stage the internal issue upstream.
    await runVenfork(['stage', 'issue', String(internal.number)], {
      cwd: localMirrorPath,
      env: { VENFORK_NONINTERACTIVE: '1' },
    });

    // Find the upstream issue. Don't use gh's `--search` — its index is
    // eventually consistent. Even the plain list endpoint has cache lag
    // for freshly-created issues, so retry a few times.
    type IssueListEntry = { number: number; url: string; body: string };
    let upstreamIssue: IssueListEntry | undefined;
    for (let attempt = 0; attempt < 5 && !upstreamIssue; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      const list =
        await $`gh issue list --repo ${UPSTREAM_OWNER}/${names.upstream} --state all --json number,url,body --limit 20`;
      const upstreamIssues = JSON.parse(list.stdout) as IssueListEntry[];
      upstreamIssue = upstreamIssues.find((i) =>
        i.body.includes('Public bug summary')
      );
    }
    expect(upstreamIssue).toBeDefined();
    expect(upstreamIssue?.body).not.toContain('Client X');
    expect(upstreamIssue?.body).not.toContain('venfork:internal');

    // Pull a different upstream issue back into the mirror.
    const upstreamReport = await createIssueOnRepo({
      owner: UPSTREAM_OWNER,
      repo: names.upstream,
      title: 'Upstream-reported bug',
      body: 'Reported by an external user.',
    });

    // Add a comment upstream so the pull has comments to carry over.
    const upstreamComment = `Follow-up detail ${RUN_ID}`;
    await $`gh issue comment ${upstreamReport.number} --repo ${UPSTREAM_OWNER}/${names.upstream} --body ${upstreamComment}`;

    await runVenfork(['pull', 'issue', String(upstreamReport.number)], {
      cwd: localMirrorPath,
      env: { VENFORK_NONINTERACTIVE: '1' },
    });

    // The mirror should now have an issue whose title carries the
    // [upstream #N] prefix and whose body references the upstream URL.
    // Same retry-with-cache-lag reasoning as above.
    type MirrorIssue = { number: number; title: string; body: string };
    let mirrorIssue: MirrorIssue | undefined;
    for (let attempt = 0; attempt < 5 && !mirrorIssue; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      const mirrorList =
        await $`gh issue list --repo ${GITHUB_ORG}/${names.mirrorBare} --state all --json number,title,body --limit 20`;
      const mirrorIssues = JSON.parse(mirrorList.stdout) as MirrorIssue[];
      mirrorIssue = mirrorIssues.find((i) =>
        i.title.includes(`upstream #${upstreamReport.number}`)
      );
    }
    expect(mirrorIssue).toBeDefined();
    expect(mirrorIssue?.body).toContain(upstreamReport.url);
    // The upstream comment was carried into the mirror copy.
    expect(mirrorIssue?.body).toContain('Upstream comment');
    expect(mirrorIssue?.body).toContain(upstreamComment);

    // Suppress unused-var warnings for helpers we leave in place for
    // future debugging hooks.
    void getIssueMeta;
    void getPrMeta;
  }, 300_000);

  test.skipIf(!REAL_DISPATCH)(
    'tier 6: no-public sync without VENFORK_PUSH_TOKEN cannot push an upstream workflow change and files an issue',
    async () => {
      // Pins that the job's GITHUB_TOKEN alone cannot push an upstream
      // commit that edits .github/workflows/ to the mirror, and that the
      // failure step reports it.
      const defaultBranch = await getRepoDefaultBranch(
        UPSTREAM_OWNER,
        names.upstream
      );
      const mirrorPath = `${tmpRoot}/${names.noPublicMirror}`;
      await runVenfork(
        [
          'setup',
          `${UPSTREAM_OWNER}/${names.upstream}`,
          names.noPublicMirror,
          '--org',
          GITHUB_ORG,
          '--no-public',
        ],
        { cwd: tmpRoot, env: { VENFORK_ORG: GITHUB_ORG }, input: 'y\n' }
      );
      await runVenfork(['schedule', 'set', '*/5 * * * *'], {
        cwd: mirrorPath,
      });
      await setRepoVariable(
        GITHUB_ORG,
        names.noPublicMirror,
        'VENFORK_INSTALL_SPEC',
        await codeUnderTestUrl()
      );

      await pokeUpstream(
        '.github/workflows/ci.yml',
        `name: ci ${RUN_ID}\non: workflow_dispatch\njobs:\n  noop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${Date.now()}\n`
      );
      const upstreamSha = await getDefaultBranchSha(
        UPSTREAM_OWNER,
        names.upstream,
        defaultBranch
      );

      const dispatchedAt = new Date();
      await $`gh workflow run venfork-sync.yml --repo ${GITHUB_ORG}/${names.noPublicMirror} --ref ${defaultBranch}`;
      const runId = await waitForDispatchedRun(
        GITHUB_ORG,
        names.noPublicMirror,
        'venfork-sync.yml',
        dispatchedAt,
        90_000
      );
      const { conclusion, url } = await waitForRunCompletion(
        GITHUB_ORG,
        names.noPublicMirror,
        runId,
        300_000
      );
      const logs = await $({
        reject: false,
      })`gh run view ${runId} --repo ${GITHUB_ORG}/${names.noPublicMirror} --log-failed`;
      console.log(
        `[venfork-e2e] tier 6 conclusion=${conclusion} url=${url}\n--- gh run view --log-failed ---\n${logs.stdout}${logs.stderr}`
      );

      expect(conclusion).toBe('failure');
      expect(logs.stdout).toContain(
        'refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission'
      );
      expect(
        await getDefaultBranchSha(
          GITHUB_ORG,
          names.noPublicMirror,
          defaultBranch
        )
      ).not.toBe(upstreamSha);
      expect(
        await listOpenIssuesWithLabel(
          GITHUB_ORG,
          names.noPublicMirror,
          'venfork-sync-blocked'
        )
      ).toHaveLength(1);
    },
    600_000
  );
});
