# Role Identity V2: multi-project loader and runtime lookup

V2 lets one bot process hold independent trusted role mappings for multiple approved GitHub repositories. This Phase 1 implementation supports `artemdut-cyber/MyFkenTS` and `artemdut-cyber/EmailAi`. EmailAi mappings are configuration capability only: this change does not install or activate an EmailAi mapping in a live CODEX_HUB.

## Schema

V1 remains supported in its existing form: `version: 1` with one `mappings` array for MyFkenTS. A V1 file keeps the existing validation and runtime path.

V2 uses explicit project sections. Each project pins one accepted governance commit and contains exactly one mapping for each role:

```json
{
  "version": 2,
  "projects": [
    {
      "repository": "artemdut-cyber/MyFkenTS",
      "acceptedGovernanceSha": "<40-character accepted main commit SHA>",
      "mappings": [
        {
          "chatId": "-1000000000001",
          "topicId": "101",
          "workspace": "/srv/example/myfkents/dev",
          "roleId": "dev",
          "rolePolicyPath": "docs/roles/dev.md"
        },
        {
          "chatId": "-1000000000001",
          "topicId": "102",
          "workspace": "/srv/example/myfkents/review",
          "roleId": "review",
          "rolePolicyPath": "docs/roles/review.md"
        },
        {
          "chatId": "-1000000000001",
          "topicId": "103",
          "workspace": "/srv/example/myfkents/qa",
          "roleId": "qa",
          "rolePolicyPath": "docs/roles/qa.md"
        }
      ]
    },
    {
      "repository": "artemdut-cyber/EmailAi",
      "acceptedGovernanceSha": "<40-character accepted main commit SHA>",
      "mappings": [
        {
          "chatId": "-1000000000002",
          "topicId": "201",
          "workspace": "/srv/example/emailai/dev",
          "roleId": "dev",
          "rolePolicyPath": "docs/agent-roles/dev.md"
        },
        {
          "chatId": "-1000000000002",
          "topicId": "202",
          "workspace": "/srv/example/emailai/review",
          "roleId": "review",
          "rolePolicyPath": "docs/agent-roles/review.md"
        },
        {
          "chatId": "-1000000000002",
          "topicId": "203",
          "workspace": "/srv/example/emailai/qa",
          "roleId": "qa",
          "rolePolicyPath": "docs/agent-roles/qa.md"
        }
      ]
    }
  ]
}
```

This is a shape example only: use verified IDs, canonical workspace paths, and accepted lowercase Git SHAs before deployment. The service continues to read the configured file from `CODEX_ROLE_IDENTITY_CONFIG_FILE`.

`repository` must be on the code allowlist. Add future projects through an explicit reviewed code change. A project must have a lowercase 40-character Git commit SHA and exactly one `dev`, `review`, and `qa` mapping. `rolePolicyPath` must be a safe repository-relative path whose filename matches the mapping's role (`dev.md`, `review.md`, or `qa.md`). Paths may not traverse directories, address `.git`, use backslashes, or resolve to symlink entries in the pinned Git tree.

## Identity and project isolation

The only role lookup key is the exact numeric `(chatId, topicId)` pair. Topic titles, user messages, role names in prompts, local folder names, and callback text do not select a role. Topic pairs and canonical physical workspaces must be unique across the entire V2 file. A workspace must exist as a directory, be an absolute canonical path, and may not be a symlink alias.

Before V2 instruction loading, runtime checks the persisted Telegram topic binding, configured working directory, canonical workspace, and exact GitHub `origin` repository. A trusted mapping whose workspace or repository differs fails before instruction loading. An unmapped topic in a configured repository fails closed. An unrelated repository remains outside Role Identity.

For a new session, runtime fetches `origin/main` and requires its commit to equal the project's configured `acceptedGovernanceSha`. It reads root `AGENTS.md` and the mapped role policy from that same commit, verifies both are regular Git files, and writes their combined instruction override. If the repository, topic, workspace, revision, common instructions, or role policy cannot be verified, the managed turn is rejected; there is no role fallback.

V1 retains its existing runtime semantics, including its existing-session short circuit. V2 checks the topic/repository/workspace binding before that short circuit so an existing session cannot bypass these Phase 1 checks. Full session provenance and cross-role resume/handoff controls are outside this phase.

## Limits and rollout

This phase implements parsing, validation, lookup, and instruction synchronization. It does not enforce GitHub write permissions, OS identity separation, protected ownership of the live config, session provenance, or role behavior after instructions reach the model. Role policies remain model instructions; use GitHub and OS permissions for actual write boundaries.

No live configuration is migrated or activated by this change. Keep EmailAi inactive until separately reviewed provisioning uses trusted live topic IDs, the accepted EmailAi governance SHA, its accepted `AGENTS.md` and policies, and verified workspace/repository bindings.

## Relationship to Draft PR #6

Draft PR #6 adds single-project role validation and hardening in the same loader, synchronizer, and role identity tests. Phase 1 reuses the physical path/origin/instruction-sync concepts but keeps V1 behavior and adds project-scoped V2 validation. The two branches overlap in `src/codex/role_identity.js` and `test/role_identity.test.mjs`; coordinate by reviewing and rebasing or superseding the PR #6 changes before either implementation is merged. This PR does not modify PR #6.
