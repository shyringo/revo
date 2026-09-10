import { randomUUID } from "node:crypto";

export class ToolRegistry {
  #tools = new Map();
  #approvals;
  #store;

  constructor({ approvals, store }) {
    this.#approvals = approvals;
    this.#store = store;
  }

  register(tool) {
    if (!tool?.name || typeof tool.execute !== "function") throw new TypeError("Invalid tool");
    if (this.#tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.#tools.set(tool.name, tool);
    return () => this.#tools.delete(tool.name);
  }

  definitions() {
    return [...this.#tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  executionMode(name) {
    return this.#tools.get(name)?.executionMode === "parallel" ? "parallel" : "sequential";
  }

  async execute(name, args, context = {}) {
    const result = await this.run(name, args, context);
    await this.record(name, args, result);
    return result;
  }

  async run(name, args, context = {}) {
    const tool = this.#tools.get(name);
    if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
    const validationError = validateArguments(tool.parameters, args);
    if (validationError) return { ok: false, error: `Invalid arguments for ${name}: ${validationError}` };
    const risk = await tool.requiresApproval?.(args, context);
    let approved = false;
    if (risk) {
      const decision = await this.#approvals.request({ tool: name, arguments: args, reason: risk, signal: context.signal });
      if (!decision.approved) {
        return { ok: false, denied: true, error: decision.note || "User denied the action" };
      }
      approved = true;
    }
    const started = Date.now();
    const intent = await this.#store.append("tool.intent", {
      executionId: randomUUID(),
      name,
      arguments: args,
      executionMode: tool.executionMode === "parallel" ? "parallel" : "sequential",
    });
    try {
      const value = await tool.execute(args, { ...context, approved });
      return { ok: true, value, durationMs: Date.now() - started, intentId: intent.id };
    } catch (error) {
      return { ok: false, error: error.message, durationMs: Date.now() - started, intentId: intent.id };
    }
  }

  async record(name, args, result) {
    const type = result.denied ? "tool.denied" : result.ok ? "tool.completed" : "tool.failed";
    await this.#store.append(type, { name, arguments: args, intentId: result.intentId, result });
  }
}

export function validateArguments(schema, value, path = "arguments") {
  if (!schema) return null;
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} must contain at least ${schema.minItems} item(s)`;
    for (let index = 0; index < value.length; index++) {
      const error = validateArguments(schema.items, value[index], `${path}[${index}]`);
      if (error) return error;
    }
    return null;
  }
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object`;
    for (const name of schema.required || []) if (!(name in value)) return `${path}.${name} is required`;
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) if (!(name in (schema.properties || {}))) return `${path}.${name} is not allowed`;
    }
    for (const [name, child] of Object.entries(schema.properties || {})) {
      if (name in value) {
        const error = validateArguments(child, value[name], `${path}.${name}`);
        if (error) return error;
      }
    }
    return null;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return `${path} must be a string`;
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} must contain at least ${schema.minLength} character(s)`;
  } else if (schema.type === "integer") {
    if (!Number.isSafeInteger(value)) return `${path} must be a safe integer`;
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a finite number`;
  }
  if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be >= ${schema.minimum}`;
  return null;
}
