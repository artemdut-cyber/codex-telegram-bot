# Telegram Dev / Review / QA role identity

This opt-in control-plane feature is enabled by `CODEX_ROLE_IDENTITY_CONFIG_FILE`, which points to a machine-local JSON file outside the application repository. The file contains trusted numeric Telegram chat/topic IDs and exact workspace paths; topic display names and Telegram message text are never consulted.

Example shape (replace every placeholder with values verified from the live forum binding):

```json
{
  "version": 1,
  "mappings": [
    {
      "chatId": "-1000000000000",
      "topicId": "201",
      "workspace": "/srv/agentdevteam/projects/codex/myfkents/repo",
      "project": "artemdut-cyber/MyFkenTS",
      "roleId": "dev",
      "rolePolicyPath": "docs/roles/dev.md"
    },
    {
      "chatId": "-1000000000000",
      "topicId": "202",
      "workspace": "/srv/agentdevteam/projects/codex/myfkents/reviewer",
      "project": "artemdut-cyber/MyFkenTS",
      "roleId": "review",
      "rolePolicyPath": "docs/roles/review.md"
    },
    {
      "chatId": "-1000000000000",
      "topicId": "203",
      "workspace": "/srv/agentdevteam/projects/codex/myfkents/tester",
      "project": "artemdut-cyber/MyFkenTS",
      "roleId": "qa",
      "rolePolicyPath": "docs/roles/qa.md"
    }
  ]
}
```

The values above are examples only. Do not infer production topic IDs or policy paths from topic titles. The config must have exactly one unique mapping per role and workspace. Keep it in the service user's machine-local configuration area, readable by the service and not writable by other users. It contains no credentials.

For a new session or `/new`, the turn lifecycle resolves the exact `(chatId, topicId)` mapping, verifies the bound workspace and GitHub origin, fetches `origin`'s `main`, then reads both `AGENTS.md` and the selected role policy from the same fetched commit. It atomically writes a complete root `AGENTS.override.md`, adds `/AGENTS.override.md` to that worktree's `.git/info/exclude`, and verifies that Git status is unchanged before the Codex turn can start. The fetched governance commit SHA is recorded in the generated file. Resumed sessions keep their already loaded instruction context.

An unmapped topic whose workspace is the MyFkenTS repository, a workspace/project mismatch, unavailable `main`, missing common/role policy, or invalid config aborts the turn before Codex starts. The bot does not fall back to task branch instructions. Ordinary private chats and other repositories remain outside this opt-in path.

The config and workspace-local Git exclude survive a bot restart; every new session deterministically regenerates the override, so changed governance on accepted `main` and stale/missing files are reconciled at the next `/new`.

## AgentDevTeam Platform project selection

Telegram role identity mapping v1 supports `artemdut-cyber/MyFkenTS` and `artemdut-cyber/agentdevteam-platform`. To select AgentDevTeam Platform, set the top-level `project` and repeat that exact repository in all three role mappings. Use the verified numeric Telegram topic IDs, one distinct absolute workspace per role, and the role policy path that exists on the selected repository's accepted `main`:

```json
{
  "version": 1,
  "project": "artemdut-cyber/agentdevteam-platform",
  "mappings": [
    {
      "chatId": "<verified-chat-id>",
      "topicId": "<dev-topic-id>",
      "workspace": "/absolute/path/to/platform-dev",
      "project": "artemdut-cyber/agentdevteam-platform",
      "roleId": "dev",
      "rolePolicyPath": "<verified-dev-policy-path>"
    },
    {
      "chatId": "<verified-chat-id>",
      "topicId": "<review-topic-id>",
      "workspace": "/absolute/path/to/platform-review",
      "project": "artemdut-cyber/agentdevteam-platform",
      "roleId": "review",
      "rolePolicyPath": "<verified-review-policy-path>"
    },
    {
      "chatId": "<verified-chat-id>",
      "topicId": "<qa-topic-id>",
      "workspace": "/absolute/path/to/platform-qa",
      "project": "artemdut-cyber/agentdevteam-platform",
      "roleId": "qa",
      "rolePolicyPath": "<verified-qa-policy-path>"
    }
  ]
}
```

The top-level project is optional only for the existing MyFkenTS format shown above. If omitted, the loader selects MyFkenTS and rejects mappings for any other repository. Mapping entries cannot mix repositories. A topic bound to the selected repository but missing from the mapping, a workspace mismatch, or an origin mismatch fails closed, including when a Telegram session already exists. Telegram role identity accepts only mapping `version: 1`; the separate Dev→QA Controller mapping v2 is not interchangeable.

## Deployment prerequisites

Do not enable this feature until all of the following are true:

1. MyFkenTS governance PR #201 is accepted, or a later accepted `main` establishes the common instruction contract.
2. Canonical Dev, Review and QA policy files exist on accepted `MyFkenTS/main` at the exact configured paths.
3. The three live numeric topic IDs and their exact bound workspaces are verified from trusted control-plane state.
4. The local mapping file and `CODEX_ROLE_IDENTITY_CONFIG_FILE` service setting are installed through the approved bot deployment procedure.
5. Live acceptance from MyFkenTS #204 passes the three `/new` probes, negative role-boundary probes, a controlled bot restart, repeat probes and clean Git checks.

No MyFkenTS service, PostgreSQL, Data Hub/FVG runtime or 1C Framework change is part of this feature PR.
