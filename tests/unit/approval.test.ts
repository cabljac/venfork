import { describe, expect, test } from 'bun:test';
import { ApprovalError } from '../../src/errors.js';
import {
  type ApprovalFacts,
  approvalCandidates,
  evaluateApproval,
  latestReviews,
} from '../../src/shared/approval.js';

const HEAD = 'c'.repeat(40);

function facts(overrides: Partial<ApprovalFacts> = {}): ApprovalFacts {
  return {
    level: 'two-person',
    branch: 'feature',
    mirror: 'acme/widget-private',
    pr: {
      number: 7,
      url: 'https://github.com/acme/widget-private/pull/7',
      headSha: HEAD,
      author: 'agent',
    },
    stager: 'stager',
    reviews: [
      { login: 'alice', type: 'User', state: 'APPROVED', commitId: HEAD },
    ],
    permissions: new Map([['alice', 'write']]),
    checks: [],
    ...overrides,
  };
}

function refusal(input: ApprovalFacts): ApprovalError {
  try {
    evaluateApproval(input);
  } catch (error) {
    if (error instanceof ApprovalError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('evaluateApproval', () => {
  test('an approval on the head from a writer passes and names the approver', () => {
    expect(evaluateApproval(facts())).toEqual({
      level: 'two-person',
      prNumber: 7,
      prUrl: 'https://github.com/acme/widget-private/pull/7',
      headSha: HEAD,
      approvers: ['alice'],
    });
  });

  test('a comment-only review after an approval keeps the approval', () => {
    const reviews = [
      { login: 'alice', type: 'User', state: 'APPROVED', commitId: HEAD },
      { login: 'alice', type: 'User', state: 'COMMENTED', commitId: HEAD },
    ];
    expect(latestReviews(reviews)).toEqual([reviews[0]]);
    expect(evaluateApproval(facts({ reviews })).approvers).toEqual(['alice']);
  });

  test('an approval after changes requested replaces them', () => {
    const reviews = [
      {
        login: 'alice',
        type: 'User',
        state: 'CHANGES_REQUESTED',
        commitId: HEAD,
      },
      { login: 'alice', type: 'User', state: 'APPROVED', commitId: HEAD },
    ];
    expect(evaluateApproval(facts({ reviews })).approvers).toEqual(['alice']);
  });

  test("another reviewer's outstanding changes request blocks an approval", () => {
    const error = refusal(
      facts({
        reviews: [
          { login: 'alice', type: 'User', state: 'APPROVED', commitId: HEAD },
          {
            login: 'bob',
            type: 'User',
            state: 'CHANGES_REQUESTED',
            commitId: 'a'.repeat(40),
          },
        ],
      })
    );
    expect(error.reason).toBe('changes-requested');
    expect(error.code).toBe('approval');
    expect(error.details).toMatchObject({
      reason: 'changes-requested',
      reviewers: ['bob'],
    });
  });

  test('reviewer logins compare without case for the stager rule', () => {
    const error = refusal(
      facts({
        stager: 'Alice',
        permissions: new Map([['alice', 'admin']]),
      })
    );
    expect(error.reason).toBe('self-approved');
    expect(error.hint).toBe(
      'Working alone? `venfork stage approval reviewed` lets the person who approved also stage.'
    );
  });

  test('neutral and skipped checks pass; a cancelled check is a failure', () => {
    expect(
      evaluateApproval(
        facts({
          checks: [
            { name: 'a', state: 'passed' },
            { name: 'b', state: 'passed' },
          ],
        })
      ).approvers
    ).toEqual(['alice']);
    expect(
      refusal(facts({ checks: [{ name: 'deploy', state: 'failed' }] })).details
    ).toMatchObject({ reason: 'checks-failed', checks: ['deploy'] });
  });

  test('a reviewer with no recorded permission does not count', () => {
    expect(refusal(facts({ permissions: new Map() })).reason).toBe(
      'not-approved'
    );
  });
  test("a dismissed changes request does not bring back the same reviewer's earlier approval", () => {
    const error = refusal(
      facts({
        reviews: [
          { login: 'alice', type: 'User', state: 'APPROVED', commitId: HEAD },
          { login: 'alice', type: 'User', state: 'DISMISSED', commitId: HEAD },
        ],
      })
    );
    expect(error.reason).toBe('not-approved');
  });

  test('a dismissed latest review neither approves nor blocks', () => {
    expect(
      evaluateApproval(
        facts({
          reviews: [
            {
              login: 'bob',
              type: 'User',
              state: 'CHANGES_REQUESTED',
              commitId: HEAD,
            },
            { login: 'bob', type: 'User', state: 'DISMISSED', commitId: HEAD },
            { login: 'alice', type: 'User', state: 'APPROVED', commitId: HEAD },
          ],
        })
      ).approvers
    ).toEqual(['alice']);
  });

  test('an older changes request still blocks after a later comment-only review', () => {
    const error = refusal(
      facts({
        reviews: [
          { login: 'alice', type: 'User', state: 'APPROVED', commitId: HEAD },
          {
            login: 'bob',
            type: 'User',
            state: 'CHANGES_REQUESTED',
            commitId: HEAD,
          },
          { login: 'bob', type: 'User', state: 'COMMENTED', commitId: HEAD },
        ],
      })
    );
    expect(error.reason).toBe('changes-requested');
  });

  test('only a reviewer of type User counts; a ghost review with no login is skipped', () => {
    const permissions = new Map([
      ['acme', 'write'],
      ['', 'write'],
    ]);
    const reviews = [
      {
        login: 'acme',
        type: 'Organization',
        state: 'APPROVED',
        commitId: HEAD,
      },
      { login: '', type: '', state: 'APPROVED', commitId: HEAD },
    ];
    expect(refusal(facts({ reviews, permissions })).reason).toBe(
      'not-approved'
    );
    expect(
      approvalCandidates('reviewed', facts().pr, 'stager', reviews)
    ).toEqual([]);
    expect(latestReviews(reviews).map((r) => r.login)).toEqual(['acme']);
  });
});
