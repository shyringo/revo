import test from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleModel } from "../src/model/openai-compatible.js";

test("model adapter preserves reasoning and parses tool calls", async () => {
  let request;
  const fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "", reasoning_content: "check", tool_calls: [{ id: "1", type: "function", function: { name: "remember", arguments: "{\"text\":\"x\"}" } }] } }],
      usage: { total_tokens: 10 },
    }));
  };
  const model = new OpenAICompatibleModel({ apiKey: "test", baseUrl: "https://example.test/v1", name: "mock", timeoutMs: 1000, maxTokens: 100 }, fetch);
  const result = await model.complete({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "remember", description: "store", parameters: { type: "object" } }], maxTokens: 42, thinking: true, reasoningEffort: "high" });
  assert.equal(request.stream, false);
  assert.equal(request.max_tokens, 42);
  assert.deepEqual(request.thinking, { type: "enabled" });
  assert.equal(request.reasoning_effort, "high");
  assert.equal(result.reasoningContent, "check");
  assert.deepEqual(result.toolCalls[0].arguments, { text: "x" });
});

test("model adapter assembles SSE text deltas for tool-free interaction", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    'data: {"choices":[],"usage":{"total_tokens":12}\n}\n\n'.replace('12}\n}', '12}}'),
    'data: [DONE]\n\n',
  ];
  const fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.stream, true);
    assert.deepEqual(body.thinking, { type: "disabled" });
    return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }));
  };
  const deltas = [];
  const model = new OpenAICompatibleModel({ apiKey: "test", baseUrl: "https://example.test/v1", name: "mock", timeoutMs: 1000, maxTokens: 100 }, fetch);
  const result = await model.complete({ messages: [{ role: "user", content: "hi" }], thinking: false, onTextDelta: (delta) => deltas.push(delta) });
  assert.equal(result.content, "你好");
  assert.deepEqual(deltas, ["你", "好"]);
  assert.equal(result.usage.total_tokens, 12);
});
