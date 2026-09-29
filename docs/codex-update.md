# Codex update panel

Open **Tools → Codex Maintenance → Codex update**. The button is below report
and backup. Opening it checks the installed CLI and latest stable release without
installing anything. An authorized administrator sees **Start update** when a
newer release is available. Refresh updates the progress view; the detached
operation sends a completion message to the requesting bot/chat/topic.

## Supported runtime

The automatic path supports Linux with user systemd, `curl`, `sh`, and `flock`,
using the official standalone installation in `CODEX_UPDATE_HOME`. The configured
`CODEX_PATH` (or the underlying configured CLI) must resolve to a symlink into that home's
`packages/standalone/releases`. Other installations show an explanation and use
their original package manager; this feature never replaces an npm/Homebrew
installation. The bot service's working directory must match the running repo.

- `CODEX_UPDATE_HOME`: canonical host home, default `~/.codex`; independent of
  an account-specific `CODEX_HOME`.
- `CODEX_UPDATE_BIN`: underlying standalone command for a custom wrapper.
  The bundled `codex-yolo` wrapper resolves `CODEX_REAL_PATH` automatically
  (including an override in `CODEX_ENV_JSON`). Wrapper and actual CLI versions
  must agree. Wrapper contents and execution flags are preserved.
- `CODEX_UPDATE_ADMIN_USER_IDS`: must be in `ALLOWED_USER_IDS`; defaults to
  `CODEX_ACCOUNT_ADMIN_USER_IDS`, or the sole allowed user. Multiple allowed
  users without configured administrators get a read-only panel.
- `CODEX_UPDATE_BOT_SERVICE`, `CODEX_UPDATE_WORKER_SERVICE`, and
  `CODEX_UPDATE_APP_SERVER_SERVICE`: user systemd unit names. Worker restart is
  required in sidecar mode; the external app-server restarts only if active.

## Operation

1. Previews expire after ten minutes and bind to the actor, chat/topic, message,
   installation, and displayed target version. The target cannot be supplied
   through arbitrary callback text.
2. A host lock serializes bot update requests. The detached systemd service also
   holds the standalone installer's native `install.lock` using `flock`.
3. The official installer from `https://chatgpt.com/codex/install.sh` runs with
   the exact approved release in an isolated home/bin directory. It verifies
   official release artifacts. Live CLI selection and user shell profiles are
   unchanged during preparation; account environments/credentials are excluded.
4. New jobs pause at `waiting_idle`. Messages remain queued, including interrupt
   and side modes. The updater requires a recent bot idle acknowledgement, no
   active/side turns or unsent final responses, and an idle worker for five
   continuous seconds. The wait is bounded to thirty minutes; timeout fails
   without cancelling jobs. The bot stops briefly and worker idle is checked
   again before selection.
5. The original command/current links and native auto-update selection marker
   are saved before switching. Existing native auto-update eligibility is preserved. Required
   services restart, CLI version and worker connectivity are checked, and the
   running external app-server executable must match the target version.
   After worker restart, a read-only status handshake retries transient socket
   startup errors for up to thirty seconds before restarting the bot. A spawned
   systemd process alone does not prove the socket is ready; permanent errors
   still fail immediately and genuine startup failure triggers rollback.
6. Verification failure restores the old links and services. After an interrupted
   switch, **Recover update** restores the persisted original selection rather
   than repeating uncertain activation. Preparation can resume if selection had
   not begun. Failed restoration keeps admission paused and retains the lock.

Models, reasoning effort, account profiles, sessions, databases and `.env` are
preserved. Older release directories remain available for rollback. Update state,
per-run results and notification receipts live under `codex-update` next to
`STATE_FILE`; runtime artifacts are never committed. Staging is removed after
terminal outcomes. A failed/uncertain notification must be reconciled using its
receipt; never repeat an update just to resend its completion message.

The global host lock is under
`CODEX_UPDATE_HOME/packages/standalone/.telegram-update-lock`. If another bot
instance owns it, inspect its recorded `owner.json` and state rather than deleting
the lock. An updater stopped by systemd can be recovered from the panel once its
service is inactive. Rollback covers binary selection and service activation;
it does not attempt to reverse runtime data migrations performed by a CLI.

For a code deployment that must reload the worker safely, a local operator can
write `deployment-pause.json` in the update state directory with a unique `id`
and a bounded numeric `expiresAt` (epoch milliseconds). Admission pauses and the
same bot idle reporter acknowledges this ID. Remove the marker after activation;
expiry also resumes admission. This marker does not represent a CLI update and
does not alter the update outcome or model settings.

Official installation reference: [Codex CLI](https://learn.chatgpt.com/docs/codex/cli).
