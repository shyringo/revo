import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const number = (value, fallback, min = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
};

export const DEFAULT_CONSTITUTION = `# Revo Constitution

1. 最长期最无限最终极的目标，是全人类的幸福和解放。
   The longest-term, most unbounded, and ultimate goal is the happiness and liberation of all humanity.
2. 不能违背人类指令。
   Revo must not disobey human instructions.`;

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const configPath = findConfigPath(env);
  const file = readConfig(configPath);
  const workspace = resolve(env.REVO_WORKSPACE || file.workspace || cwd);
  const constitutionPath = env.REVO_CONSTITUTION || file.constitutionPath || null;
  const config = {
    configPath,
    constitutionPath: constitutionPath ? resolve(constitutionPath) : null,
    constitution: constitutionPath ? readConstitution(constitutionPath) : DEFAULT_CONSTITUTION,
    constitutionSource: constitutionPath ? resolve(constitutionPath) : "built-in founding articles",
    plugins: Array.isArray(file.plugins) ? [...file.plugins] : [],
    workspace,
    stateDir: resolve(env.REVO_STATE_DIR || file.stateDir || `${workspace}/.revo`),
    model: {
      locked: file.model?.locked === true,
      apiKey: env.REVO_API_KEY || file.model?.apiKey || "",
      baseUrl: env.REVO_BASE_URL || file.model?.baseUrl || "https://opencode.ai/zen/go/v1",
      name: env.REVO_MODEL || file.model?.name || "deepseek-v4-flash",
      timeoutMs: number(env.REVO_MODEL_TIMEOUT_MS ?? file.model?.timeoutMs, 120_000, 1000),
      maxTokens: number(env.REVO_MAX_OUTPUT_TOKENS ?? file.model?.maxTokens, 4096, 256),
    },
    life: {
      durationMs: number(env.REVO_AWAKE_MS ?? file.life?.durationMs, Infinity, 1000),
      tokenBudget: number(env.REVO_TOKEN_BUDGET ?? file.life?.tokenBudget, Infinity, 1000),
      maxStepsPerCycle: number(env.REVO_MAX_STEPS_PER_CYCLE ?? file.life?.maxStepsPerCycle, 8, 1),
      contextWindowTokens: number(env.REVO_CONTEXT_WINDOW_TOKENS ?? file.life?.contextWindowTokens, 1_048_576, 10_000),
      compactAtTokens: number(env.REVO_COMPACT_AT_TOKENS ?? file.life?.compactAtTokens, 120_000, 5_000),
      eventSafetyLimit: number(env.REVO_EVENT_SAFETY_LIMIT ?? file.life?.eventSafetyLimit, 2_000, 100),
      recentEvents: number(env.REVO_RECENT_EVENTS ?? file.life?.recentEvents, 40, 5),
      retryMs: number(env.REVO_RETRY_MS ?? file.life?.retryMs, 2_000, 100),
    },
    policy: {
      commandTimeoutMs: number(env.REVO_COMMAND_TIMEOUT_MS ?? file.policy?.commandTimeoutMs, 30_000, 1000),
      approvalMode: env.REVO_APPROVAL_MODE || file.policy?.approvalMode || "destructive",
    },
    communication: {
      proactiveMinIntervalMs: number(env.REVO_PROACTIVE_MIN_INTERVAL_MS ?? file.communication?.proactiveMinIntervalMs, 300_000, 0),
      proactiveMaxPerHour: number(env.REVO_PROACTIVE_MAX_PER_HOUR ?? file.communication?.proactiveMaxPerHour, 4, 1),
    },
    workgraph: {
      maxConcurrency: number(env.REVO_WORKGRAPH_CONCURRENCY ?? file.workgraph?.maxConcurrency, 3, 1),
      maxOutstanding: number(env.REVO_WORKGRAPH_MAX_OUTSTANDING ?? file.workgraph?.maxOutstanding, 12, 1),
    },
  };
  if (!["destructive", "always"].includes(config.policy.approvalMode)) {
    throw new Error("REVO_APPROVAL_MODE must be destructive or always");
  }
  if (config.life.compactAtTokens >= config.life.contextWindowTokens - config.model.maxTokens) {
    throw new Error("REVO_COMPACT_AT_TOKENS must leave room for model output inside the context window");
  }
  return config;
}

function readConstitution(path) {
  if (!path) return "";
  try { return readFileSync(resolve(path), "utf8").trim(); }
  catch (error) { throw new Error(`Cannot read Revo constitution ${path}: ${error.message}`); }
}

function findConfigPath(env) {
  if (env.REVO_CONFIG) return resolve(env.REVO_CONFIG);
  const portable = resolve(homedir(), ".config", "revo", "config.json");
  return existsSync(portable) ? portable : null;
}

function readConfig(path) {
  if (!path) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("root must be an object");
    return value;
  } catch (error) {
    throw new Error(`Cannot read Revo config ${path}: ${error.message}`);
  }
}
