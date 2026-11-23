import { afterEach, describe, expect, it } from "bun:test";
import { chatDash, getDashQuota } from "./dash";

const originalFetch = globalThis.fetch;
const DEVICE_ID = "dsh_test_device_000000000001";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function streamResponse(stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", ...headers },
  });
}

/** chatDash with an explicit device ID so tests never touch the real machine ID. */
function chat(
  model: string,
  messages: Parameters<typeof chatDash>[1],
  tools: Parameters<typeof chatDash>[2] = [],
  callbacks: Parameters<typeof chatDash>[3] = {},
  generation: Parameters<typeof chatDash>[4] = {},
) {
  return chatDash(model, messages, tools, callbacks, generation, { deviceId: DEVICE_ID });
}

describe("Dash backend SSE client", () => {
  it("renders fragments before the upstream stream completes and handles split frames", async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>(resolve => { markFetchStarted = resolve; });
    let firstTextResolve!: () => void;
    const firstText = new Promise<void>(resolve => { firstTextResolve = resolve; });

    globalThis.fetch = (async () => streamResponse(new ReadableStream({
      start(streamController) {
        controller = streamController;
        markFetchStarted();
      },
    }))) as unknown as typeof fetch;

    const received: string[] = [];
    let thinking = false;
    const resultPromise = chat(
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      [{ role: "user", content: "hi" }],
      [],
      {
        onThinking: () => { thinking = true; },
        onText: chunk => {
          received.push(chunk);
          firstTextResolve();
        },
      },
    );

    await fetchStarted;

    // Two frames in one network chunk, with the second JSON object cut in half.
    controller.enqueue(encoder.encode(
      'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"lo',
    ));

    await Promise.race([
      firstText,
      new Promise((_, reject) => setTimeout(() => reject(new Error("no incremental text")), 2000)),
    ]);
    expect(received).toEqual(["Hel"]);
    expect(thinking).toBe(true);

    // Finish the partial frame, add a finish reason, and complete the stream.
    controller.enqueue(encoder.encode(
      '"}}]}\n\n'
      + 'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n'
      + "data: [DONE]\n\n",
    ));
    controller.close();

    const result = await resultPromise;
    expect(received).toEqual(["Hel", "lo"]);
    expect(result.content).toBe("Hello");
    expect(result.toolCalls).toHaveLength(0);
  });

  it("sends the selected model ID, device ID, tools, generation options, and tool history", async () => {
    let requestBody: Record<string, any> = {};
    let requestHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? "{}"));
      requestHeaders = (init?.headers ?? {}) as Record<string, string>;
      return streamResponse(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
          ));
          controller.close();
        },
      }), {
        "X-RateLimit-Limit": "100000",
        "X-RateLimit-Remaining": "99999",
        "X-RateLimit-Reset": "2026-10-30T00:00:00.000Z",
        "X-RateLimit-Day": "2026-10-29",
      });
    }) as unknown as typeof fetch;

    const result = await chat(
      "nvidia/nemotron-3-ultra-550b-a55b",
      [
        { role: "user", content: "inspect" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "read_file", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_0", content: "file body" },
      ],
      [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
      {},
      { temperature: 0.2, topP: 0.8, maxOutputTokens: 512, reasoningEffort: "low" },
    );

    expect(result.content).toBe("ok");
    expect(requestBody.model).toBe("nvidia/nemotron-3-ultra-550b-a55b");
    expect(requestBody.stream).toBe(true);
    expect(requestBody.temperature).toBe(0.2);
    expect(requestBody.top_p).toBe(0.8);
    expect(requestBody.max_tokens).toBe(512);
    expect(requestBody.reasoning_effort).toBe("low");
    expect(requestBody.tools).toHaveLength(1);
    expect(requestBody.messages[1].tool_calls[0].id).toBe("call_0");
    expect(requestBody.messages[2].tool_call_id).toBe("call_0");
    expect(requestHeaders["X-Device-Id"]).toBe(DEVICE_ID);
    expect(requestHeaders.Authorization).toBeUndefined();
    expect(JSON.stringify(requestHeaders)).not.toContain("nvapi-");
    expect(result.quota).toEqual({
      limit: 100_000,
      remaining: 99_999,
      resetAt: "2026-10-30T00:00:00.000Z",
      day: "2026-10-29",
    });
  });

  it("surfaces a quota error with the reset time instead of an empty reply", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({
        success: false,
        code: "quota_exceeded",
        error: "Daily token limit reached (100,000 of 100,000 tokens used).",
        resetAt: "2026-10-30T00:00:00.000Z",
        used: 100_000,
        limit: 100_000,
      }),
      { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "3600" } },
    )) as unknown as typeof fetch;

    const result = await chat("nvidia/nemotron-3.5-lightning-30b-a3b", [{ role: "user", content: "hi" }]);
    expect(result.content).toContain("Daily token limit reached");
    expect(result.content).toContain("2026-10-30T00:00:00.000Z");
    expect(result.toolCalls).toHaveLength(0);
  });

  it("surfaces a mid-stream quota stop and keeps the partial answer", async () => {
    globalThis.fetch = (async () => new Response(
      'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'
      + 'data: {"error":{"code":"quota_exceeded","message":"Daily token limit reached. Resets soon."}}\n\n'
      + "data: [DONE]\n\n",
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    )) as unknown as typeof fetch;

    const result = await chat("nvidia/nemotron-3.5-lightning-30b-a3b", [{ role: "user", content: "hi" }]);
    expect(result.content).toContain("Partial");
    expect(result.content).toContain("Daily token limit reached");
  });

  it("loads the quota limit from the backend quota endpoint", async () => {
    let requestUrl = "";
    globalThis.fetch = (async (input: unknown) => {
      requestUrl = String(input);
      return new Response(JSON.stringify({
        success: true,
        quota: {
          day: "2026-10-30",
          used: 12_345,
          limit: 100_000,
          remaining: 87_655,
          resetAt: "2026-10-31T00:00:00.000Z",
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const quota = await getDashQuota(DEVICE_ID);

    expect(requestUrl).toContain("/api/quota");
    expect(quota?.limit).toBe(100_000);
    expect(quota?.used).toBe(12_345);
  });

  it("surfaces a non-2xx JSON error instead of silently returning empty content", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ success: false, error: "The requested model is not approved" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;

    const result = await chat("not/approved", [{ role: "user", content: "hi" }]);
    expect(result.content).toBe("Error: The requested model is not approved");
    expect(result.toolCalls).toHaveLength(0);
  });

  it("keeps partial output and marks a provider error frame", async () => {
    globalThis.fetch = (async () => new Response(
      'data: {"choices":[{"delta":{"content":"Partial answer"}}]}\n\n'
      + 'data: {"error":{"message":"upstream exploded"}}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    )) as unknown as typeof fetch;

    const result = await chat("nvidia/nemotron-3.5-lightning-30b-a3b", [{ role: "user", content: "hi" }]);
    expect(result.content).toContain("Partial answer");
    expect(result.content).toContain("Generation failed: upstream exploded");
  });

  it("marks a partial response as interrupted when the stream closes without a completion marker", async () => {
    globalThis.fetch = (async () => new Response(
      'data: {"choices":[{"delta":{"content":"Half"}}]}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    )) as unknown as typeof fetch;

    const result = await chat("nvidia/nemotron-3.5-lightning-30b-a3b", [{ role: "user", content: "hi" }]);
    expect(result.content).toContain("Half");
    expect(result.content).toContain("Response interrupted before completion");
  });

  it("does not present an empty stream as a successful answer", async () => {
    globalThis.fetch = (async () => new Response(
      "data: [DONE]\n\n",
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    )) as unknown as typeof fetch;

    const result = await chat("nvidia/nemotron-3.5-lightning-30b-a3b", [{ role: "user", content: "hi" }]);
    expect(result.content.startsWith("Error:")).toBe(true);
  });

  it("propagates cancellation without throwing an unhandled error", async () => {
    const controller = new AbortController();
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>(resolve => { markFetchStarted = resolve; });

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      return streamResponse(new ReadableStream({
        start(streamController) {
          markFetchStarted();
          signal?.addEventListener("abort", () => {
            streamController.error(new Error("aborted"));
          }, { once: true });
        },
      }));
    }) as unknown as typeof fetch;

    const promise = chat(
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      [{ role: "user", content: "hi" }],
      [],
      { signal: controller.signal },
    );

    await fetchStarted;
    await Bun.sleep(10);
    controller.abort();

    await expect(promise).rejects.toThrow();
  });
});
