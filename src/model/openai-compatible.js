export class OpenAICompatibleModel {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async complete({ messages, tools = [], signal, maxTokens, onTextDelta, thinking, reasoningEffort }) {
    if (!this.config.apiKey) throw new Error("REVO_API_KEY is not set");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Model request timed out")), this.config.timeoutMs);
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const streaming = typeof onTextDelta === "function" && tools.length === 0;
      const response = await this.fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.name,
          messages,
          tools: tools.length ? tools.map(toWireTool) : undefined,
          tool_choice: tools.length ? "auto" : undefined,
          max_tokens: maxTokens ?? this.config.maxTokens,
          thinking: thinking === undefined ? undefined : { type: thinking ? "enabled" : "disabled" },
          reasoning_effort: reasoningEffort,
          stream: streaming,
          stream_options: streaming ? { include_usage: true } : undefined,
        }),
        signal: controller.signal,
      });
      if (streaming && response.ok) return await readStreamingResponse(response, onTextDelta);
      const text = await response.text();
      if (!response.ok) throw new Error(`Model HTTP ${response.status}: ${safeError(text)}`);
      const body = JSON.parse(text);
      const message = body.choices?.[0]?.message;
      if (!message) throw new Error("Model returned no message");
      return {
        role: "assistant",
        content: message.content || "",
        reasoningContent: message.reasoning_content,
        toolCalls: (message.tool_calls || []).map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: parseArguments(call.function.arguments),
          rawArguments: call.function.arguments,
        })),
        usage: body.usage || {},
        rawMessage: message,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

async function readStreamingResponse(response, onTextDelta) {
  if (!response.body) throw new Error("Streaming model returned no response body");
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningContent = "";
  let usage = {};
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data);
      if (event.usage) usage = event.usage;
      const delta = event.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        onTextDelta(delta.content, content);
      }
      if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
    }
  }
  const rawMessage = {
    role: "assistant",
    content,
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
  };
  return { role: "assistant", content, reasoningContent: reasoningContent || undefined, toolCalls: [], usage, rawMessage };
}

function toWireTool(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || { type: "object", properties: {} },
    },
  };
}

function parseArguments(value) {
  if (typeof value === "object") return value;
  try { return JSON.parse(value || "{}"); }
  catch { return { _invalidJson: value }; }
}

function safeError(text) {
  return text.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]").slice(0, 1000);
}
