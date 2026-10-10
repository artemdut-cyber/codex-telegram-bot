import path from "node:path";
import {
  CONFIG_VALID,
  assertEnum,
  normalizeMultilineEnv,
  parseCompactStrength,
  parseCsv,
  parseNonnegativeInteger,
  parseOptionalBoolean,
  parseOptionalJson,
  parsePercentInteger
} from "./parsers.js";

export function readCodexConfig(env, paths) {
  const selections = readCodexSelections(env);
  return {
    ...readCodexRuntimeConfig(env, paths, selections),
    ...readCodexModelConfig(env, selections),
    ...readCodexContextConfig(env, paths)
  };
}

function readCodexSelections(env) {
  const approvalPolicy = env.CODEX_APPROVAL_POLICY?.trim() || "never";
  const sandboxMode = env.CODEX_SANDBOX_MODE?.trim() || "workspace-write";
  const reasoningEffort = env.CODEX_REASONING_EFFORT?.trim() || "medium";
  const webSearch = env.CODEX_WEB_SEARCH?.trim() || "disabled";
  const transport = env.CODEX_TRANSPORT?.trim() || "sdk";
  const workerMode = env.CODEX_WORKER_MODE?.trim() || "sidecar";
  assertEnum(approvalPolicy, CONFIG_VALID.approval, "CODEX_APPROVAL_POLICY");
  assertEnum(sandboxMode, CONFIG_VALID.sandbox, "CODEX_SANDBOX_MODE");
  assertEnum(reasoningEffort, CONFIG_VALID.reasoning, "CODEX_REASONING_EFFORT");
  assertEnum(webSearch, CONFIG_VALID.webSearch, "CODEX_WEB_SEARCH");
  assertEnum(transport, CONFIG_VALID.codexTransport, "CODEX_TRANSPORT");
  assertEnum(workerMode, CONFIG_VALID.codexWorkerMode, "CODEX_WORKER_MODE");
  return { approvalPolicy, reasoningEffort, sandboxMode, transport, webSearch, workerMode };
}

function readCodexRuntimeConfig(env, paths, selections) {
  const workerStateDir = env.CODEX_WORKER_STATE_DIR?.trim() || path.join(paths.stateRoot, "worker");
  const slackJobSocket = env.CODEX_SLACK_JOB_SOCKET?.trim() || "";
  const slackJobUid = parseOptionalUnixId(env.CODEX_SLACK_JOB_UID, "CODEX_SLACK_JOB_UID");
  const slackJobGid = parseOptionalUnixId(env.CODEX_SLACK_JOB_GID, "CODEX_SLACK_JOB_GID");
  const slackJobWorkspace = env.CODEX_SLACK_JOB_WORKSPACE?.trim() || "";
  if (slackJobSocket && slackJobSocket !== "/run/adtplat/codexhub-slack-job-v1.sock") {
    throw new Error("CODEX_SLACK_JOB_SOCKET must use the reviewed CODEX_HUB Slack job socket path.");
  }
  if (slackJobSocket && slackJobSocket === (env.CODEX_WORKER_SOCKET?.trim() || path.join(workerStateDir, "worker.sock"))) {
    throw new Error("CODEX_SLACK_JOB_SOCKET must remain separate from the private Telegram worker socket.");
  }
  if (slackJobSocket && (!slackJobUid || !slackJobGid || !path.isAbsolute(slackJobWorkspace))) {
    throw new Error("CODEX_SLACK_JOB_SOCKET requires a non-root Slack UID, socket GID, and absolute Developer workspace.");
  }
  if (!slackJobSocket && (slackJobUid !== null || slackJobGid !== null || slackJobWorkspace)) {
    throw new Error("CODEX_SLACK_JOB_UID, CODEX_SLACK_JOB_GID, and CODEX_SLACK_JOB_WORKSPACE require CODEX_SLACK_JOB_SOCKET.");
  }
  return {
    codexWorkdir: env.CODEX_WORKDIR?.trim() || paths.homeDir,
    codexPath: env.CODEX_PATH?.trim() || "codex",
    codexTransport: selections.transport,
    codexAppServerDirectTimeoutMs: parseNonnegativeInteger(
      env.CODEX_APP_SERVER_DIRECT_TIMEOUT_MS,
      5000,
      "CODEX_APP_SERVER_DIRECT_TIMEOUT_MS"
    ),
    codexWorkerMode: selections.workerMode,
    codexWorkerStateDir: workerStateDir,
    codexWorkerLogRetentionDays: parseNonnegativeInteger(
      env.CODEX_WORKER_LOG_RETENTION_DAYS, 30, "CODEX_WORKER_LOG_RETENTION_DAYS"
    ),
    codexWorkerSocket: env.CODEX_WORKER_SOCKET?.trim() || path.join(workerStateDir, "worker.sock"),
    codexSlackJobSocket: slackJobSocket,
    codexSlackJobUid: slackJobUid,
    codexSlackJobGid: slackJobGid,
    codexSlackJobWorkspace: slackJobWorkspace,
    codexWorkerConnectTimeoutMs: parseNonnegativeInteger(
      env.CODEX_WORKER_CONNECT_TIMEOUT_MS,
      5000,
      "CODEX_WORKER_CONNECT_TIMEOUT_MS"
    ),
    codexWorkerEventPollMs: parseNonnegativeInteger(
      env.CODEX_WORKER_EVENT_POLL_MS,
      1000,
      "CODEX_WORKER_EVENT_POLL_MS"
    )
  };
}

function parseOptionalUnixId(value, name) {
  if (value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe integer.`);
  return parsed;
}

function readCodexModelConfig(env, selections) {
  return {
    codexModel: env.CODEX_MODEL?.trim() || "",
    codexApprovalPolicy: selections.approvalPolicy,
    codexSandboxMode: selections.sandboxMode,
    codexReasoningEffort: selections.reasoningEffort,
    codexWebSearch: selections.webSearch,
    codexPersonaPrompt: normalizeMultilineEnv(env.CODEX_PERSONA_PROMPT),
    codexNetworkAccess: parseOptionalBoolean(env.CODEX_NETWORK_ACCESS),
    codexWebSearchEnabled: parseOptionalBoolean(env.CODEX_WEB_SEARCH_ENABLED),
    codexSkipGitRepoCheck: parseOptionalBoolean(env.CODEX_SKIP_GIT_REPO_CHECK) ?? false,
    codexAdditionalDirectories: parseCsv(env.CODEX_ADDITIONAL_DIRECTORIES),
    codexBaseUrl: env.CODEX_BASE_URL?.trim() || "",
    codexApiKey: env.CODEX_API_KEY?.trim() || "",
    codexConfig: parseOptionalJson(env, "CODEX_CONFIG_JSON"),
    codexEnv: parseOptionalJson(env, "CODEX_ENV_JSON")
  };
}

function readCodexContextConfig(env, paths) {
  return {
    codexModelContextWindow: parseNonnegativeInteger(
      env.CODEX_MODEL_CONTEXT_WINDOW,
      0,
      "CODEX_MODEL_CONTEXT_WINDOW"
    ),
    codexAutoCompactTokenLimit: parseNonnegativeInteger(
      env.CODEX_AUTO_COMPACT_TOKEN_LIMIT,
      0,
      "CODEX_AUTO_COMPACT_TOKEN_LIMIT"
    ),
    codexToolOutputTokenLimit: parseNonnegativeInteger(
      env.CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
      0,
      "CODEX_TOOL_OUTPUT_TOKEN_LIMIT"
    ),
    codexCompactStrength: parseCompactStrength(env.CODEX_COMPACT_STRENGTH),
    codexCompactPromptFile: env.CODEX_COMPACT_PROMPT_FILE?.trim() || "",
    codexContextGuardEnabled: parseOptionalBoolean(env.CODEX_CONTEXT_GUARD_ENABLED) ?? true,
    codexContextCompactThresholdPercent: parsePercentInteger(
      env.CODEX_CONTEXT_COMPACT_THRESHOLD_PERCENT,
      75,
      "CODEX_CONTEXT_COMPACT_THRESHOLD_PERCENT"
    ),
    codexContextMinRemainingTokens: parseNonnegativeInteger(
      env.CODEX_CONTEXT_MIN_REMAINING_TOKENS,
      40000,
      "CODEX_CONTEXT_MIN_REMAINING_TOKENS"
    ),
    codexModelsCacheFile: env.CODEX_MODELS_CACHE_FILE?.trim()
      || path.join(paths.codexHome, "models_cache.json")
  };
}
