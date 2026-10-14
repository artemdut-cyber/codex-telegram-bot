# CODEX_HUB Slack job-only socket

Status: **source-only Draft PR; disabled by default; no live worker test**.
This change adds an optional AF_UNIX listener to the existing worker process.
It does not add a process, dispatcher, queue, credential, or deployment.

## Boundary and protocol

The listener is enabled only when `CODEX_SLACK_JOB_SOCKET` is set to exactly
`/run/adtplat/codexhub-slack-job-v1.sock`; the Slack UID, dedicated socket GID,
and approved Developer workspace must also be configured. With those values
unset, the worker creates only its existing private Telegram socket.

The dedicated socket is owned by the worker UID, group-owned by the configured
socket GID, and mode `0660`. The worker checks Linux `SO_PEERCRED` on every
accepted connection and requires the configured non-root Slack UID. Missing
credentials, an unsupported OS, an unexpected path entry, or unsafe runtime
directory fails closed. The peer credential binding is loaded only when the
optional listener is enabled.

The listener permits only `worker/status`, `job/start`, `job/status`, and
`job/events`. Its status response reveals only whether any worker job is
active. Status and events require a durable `slackJobV1` marker on a
canonical `slack-agentdevteam-platform-issue-N` job. The server adds the marker
after validating the request and shares the normal worker's admission lock,
durable job store, event log, executor, and duplicate-ID handling.

`job/start` accepts the Platform PR #40 wire shape only: canonical Issue URL
for `artemdut-cyber/agentdevteam-platform`, stable ID/progress ID, the pinned
`manual:agentdevteam-platform:developer` chat namespace, fixed Issue task text,
empty image list/thread ID, default account, the configured canonical workspace,
and exactly `sandboxMode=workspace-write`. Extra fields, options, account or
workspace overrides, shell input, and mismatched projects are rejected. The
normal worker socket keeps its existing protocol and permissions.

## Safe host connection review

These are review gates for a separately authorized operator; this PR does not
perform them.

1. Confirm the existing worker and Slack service identities from the target
   host. Recheck the Slack UID at activation time; do not rely on a previously
   reported UID. The Slack UID must be non-root and must not be the worker UID.
2. Provision `/run/adtplat` as an access-controlled, non-symlink runtime
   directory owned by root or the worker UID, with no group/world write bit.
   Make it traversable by the worker and only the dedicated Slack socket group.
3. Use a dedicated group containing only the worker service identity (so it
   can set the socket GID) and the approved Slack service identity. Do not add
   Slack to the `codex-agent` group or grant access to its home or private
   socket. Confirm no unrelated UID receives access through another ACL.
4. Confirm the Developer workspace is the approved project checkout, exists as
   a canonical non-symlink directory, and is outside the worker's home and
   Codex home. The source pins it from protected worker configuration.
5. Review the deployed Node runtime/build environment for the optional native
   `peercred` binding. Enabling the listener must fail closed if the Linux
   `SO_PEERCRED` binding is unavailable.
6. Only after independent source review and explicit deployment authorization,
   set the four `CODEX_SLACK_JOB_*` values through protected worker service
   configuration. Do not place them in Slack configuration or an unprotected
   environment file. Restart only through the authorized operational change.
7. Verify `/run/adtplat/codexhub-slack-job-v1.sock` owner, group and `0660`
   mode; test the four allowed calls and denial of `job/cancel`,
   `worker/archive`, `job/delivered`, an unauthorized UID, and non-Slack job
   reads. Confirm the existing private Telegram socket still reports its full
   status and accepts normal Telegram jobs. Do not dispatch a real Codex job as
   part of this source review.

## Rollback

After separate operator authorization, remove the four `CODEX_SLACK_JOB_*`
values from the worker's protected configuration and restart the existing
worker through its normal service procedure. The worker then starts only the
original Telegram socket. If a stale dedicated socket remains after a
verified worker stop, confirm it is the exact dedicated pathname and is owned
by the worker UID before removing it. Never change or remove the private
Telegram socket, `codex-agent` home, job store, or unrelated services. Revert
the source PR separately if code rollback is required; do not merge or deploy
as part of this PR.
