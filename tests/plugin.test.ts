// 插件行为测试：用假的豆包上游驱动 loader.fetch，校验三种协议的输出。
// 运行方式：npm test

import assert from "node:assert/strict";
import { test } from "node:test";

import { DoubaoTranslatePlugin } from "../src/index.ts";
import type { FetchInput, HostAuth, HostConfig } from "../src/types.ts";
import { at } from "./helpers.ts";

// 记录发往上游的请求：正文已按 JSON 解析，便于断言参数转换结果。
interface UpstreamCall {
    url: string;
    body: Record<string, unknown> | null;
}

// 宿主（Magpie）保存的登录凭据形状：type 固定为 api，key 即 Cookie。
const AUTH: HostAuth = { type: "api", key: "sessionid=abc; sid_tt=def; uid_tt=ghi" };
const BASE = "https://doubao-translate.invalid";

// 构造豆包风格的 SSE 响应：一个数据帧 + 可选的 done 帧。
function sseResponse(
    items: unknown[],
    {done = true, code = 0, event = "json"}: {done?: boolean; code?: number; event?: string} = {}
): Response {
    const frames = [
        `event: ${event}\ndata: ${JSON.stringify({ code, data: { items } })}\n\n`,
        done ? "event: done\ndata: {}\n\n" : "",
    ];
    return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
}

// 走一遍完整的插件调用链，并记录发往上游的请求，便于断言参数转换结果。
async function request(
    body: unknown,
    {path = "/v1/chat/completions", headers = {}, reply, options = {}}: {
        path?: string;
        headers?: Record<string, string>;
        reply: () => Response;
        options?: Record<string, unknown>;
    }
): Promise<{response: Response; text: string; calls: UpstreamCall[]}> {
    const calls: UpstreamCall[] = [];
    const realFetch = globalThis.fetch;
    // DoubaoClient 在构造时就捕获 fetch，所以必须在创建插件前替换。
    globalThis.fetch = async (url: FetchInput, init?: RequestInit) => {
        calls.push({url: String(url), body: typeof init?.body === "string" ? JSON.parse(init.body) : null});
        return reply();
    };
    try {
        const plugin = await DoubaoTranslatePlugin({}, options);
        const loader = await plugin.auth.loader(async () => AUTH);
        const response = await loader.fetch(`${BASE}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
        });
        return { response, text: await response.text(), calls };
    } finally {
        globalThis.fetch = realFetch;
    }
}

// 默认回复：单段译文。
const echo = (text = "你好") => () => sseResponse([{ index: 0, res: text, detect_lang: "en" }]);

// 取第 index 次上游调用的请求体（一定有，取不到说明插件没发请求）。
const bodyOf = (calls: UpstreamCall[], index: number): Record<string, unknown> => {
    const body = at(calls, index).body;
    if (!body) throw new Error(`第 ${index} 次上游调用没有 JSON 请求体`);
    return body;
};

// 注册供应商时应暴露三个模型，供 Magpie 列表展示。
test("provider config registers the three models", async () => {
    const plugin = await DoubaoTranslatePlugin({}, {});
    const config: HostConfig = {};
    await plugin.config(config);
    const provider = config.provider?.["doubao-translate"];
    assert.ok(provider, "应当注册 doubao-translate 供应商");
    assert.equal(provider.name, "Doubao Translation");
    assert.deepEqual(Object.keys(provider.models), ["doubao-ai", "volcengine-translate", "microsoft-translator"]);
});

// schema 是 strict 的，非法选项必须直接报错，不能静默用默认值。
test("invalid options are rejected", async () => {
    await assert.rejects(() => DoubaoTranslatePlugin({}, { targetLang: "klingon" }), /Invalid Doubao plugin options/);
});

// 非流式 Chat Completions：译文正确，且 usage 是估算出来的非零值。
test("openai-chat returns a completion with estimated usage", async () => {
    const { response, text, calls } = await request(
        { model: "doubao-ai", messages: [{ role: "user", content: "Translate to Chinese: Hello world" }] },
        { reply: echo() },
    );
    assert.equal(response.status, 200);
    const payload = JSON.parse(text);
    assert.equal(payload.object, "chat.completion");
    assert.equal(payload.choices[0].message.content, "你好");
    assert.equal(payload.usage.total_tokens, payload.usage.prompt_tokens + payload.usage.completion_tokens);
    assert.ok(payload.usage.prompt_tokens > 0);
    assert.equal(bodyOf(calls, 0).target_lang, "zh");
    assert.equal(bodyOf(calls, 0).translate_service, "1");
});

// 只有 stream_options.include_usage 为真时才补 usage 帧。
test("openai-chat streams usage only when requested", async () => {
    const body = { model: "doubao-ai", stream: true, messages: [{ role: "user", content: "Translate to Chinese: Hello" }] };
    const withoutUsage = await request(body, { reply: echo() });
    assert.match(withoutUsage.text, /^data: /);
    assert.match(withoutUsage.text, /data: \[DONE\]\n\n$/);
    assert.doesNotMatch(withoutUsage.text, /"usage"/);

    const withUsage = await request({ ...body, stream_options: { include_usage: true } }, { reply: echo() });
    assert.match(withUsage.text, /"usage"/);
});

// Anthropic 的系统提示用于识别语言，不应进入正文。
test("anthropic accepts a system prompt and returns a message", async () => {
    const { text } = await request(
        { model: "doubao-ai", system: "Translate to German.", messages: [{ role: "user", content: "Hello" }] },
        { path: "/v1/messages", reply: echo("Hallo") },
    );
    const payload = JSON.parse(text);
    assert.equal(payload.type, "message");
    assert.equal(payload.content[0].text, "Hallo");
});

// Responses 协议用 instructions + input 描述同一次翻译。
test("responses accepts instructions and returns output text", async () => {
    const { text } = await request(
        { model: "doubao-ai", instructions: "Translate to Spanish.", input: "Hello" },
        { path: "/v1/responses", reply: echo("Hola") },
    );
    const payload = JSON.parse(text);
    assert.equal(payload.object, "response");
    assert.equal(payload.output[0].content[0].text, "Hola");
});

// Responses 流式需发出完整的事件序列，客户端才认。
test("responses SSE emits the full lifecycle", async () => {
    const { text } = await request(
        { model: "doubao-ai", stream: true, input: "Translate to Spanish: Hello" },
        { path: "/v1/responses", reply: echo("Hola") },
    );
    for (const event of ["response.created", "response.in_progress", "response.output_item.added",
        "response.content_part.added", "response.output_text.delta", "response.output_text.done",
        "response.content_part.done", "response.output_item.done", "response.completed"]) {
        assert.match(text, new RegExp(`event: ${event}\\n`));
    }
    assert.match(text, /"delta":"Hola"/);
});

// 请求头指定的目标语言优先于插件默认值。
test("the x-doubao-target-lang header wins over the default", async () => {
    const { calls } = await request(
        { model: "volcengine-translate", messages: [{ role: "user", content: "Hello" }] },
        { headers: { "x-doubao-target-lang": "ja" }, reply: echo("こんにちは") },
    );
    assert.equal(bodyOf(calls, 0).target_lang, "ja");
    assert.equal(bodyOf(calls, 0).translate_service, "0");
});

// 多段正文合成一个批次，减少上游请求数。
test("multiple lines are translated in one batched request", async () => {
    const { calls } = await request(
        { model: "doubao-ai", messages: [{ role: "user", content: "Translate to Chinese:\n\nline one\n\nline two" }] },
        { reply: () => sseResponse([{ index: 0, res: "A1" }, { index: 1, res: "A2" }]) },
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(bodyOf(calls, 0).raw_text, ["line one", "line two"]);
});

// 上游登录失效要转成 401 + X-Magpie-Sign-In，宿主据此提示重新登录。
test("an expired upstream login maps to a sign-in error", async () => {
    const { response, text } = await request(
        { model: "doubao-ai", messages: [{ role: "user", content: "Translate to Chinese: Hello" }] },
        { reply: () => sseResponse([], { code: 710012001 }) },
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("x-magpie-sign-in"), "expired");
    assert.equal(JSON.parse(text).error.type, "authentication_error");
});

// 不支持的能力拒绝；未知模型返回 404 而非 400。
test("unsupported capabilities and unknown models are refused", async () => {
    const withTools = await request(
        { model: "doubao-ai", tools: [{ type: "function" }], messages: [{ role: "user", content: "Translate to Chinese: Hello" }] },
        { reply: echo() },
    );
    assert.equal(withTools.response.status, 400);
    assert.equal(JSON.parse(withTools.text).error.code, "unsupported_feature");

    const badModel = await request(
        { model: "nope", messages: [{ role: "user", content: "Translate to Chinese: Hello" }] },
        { reply: echo() },
    );
    assert.equal(badModel.response.status, 404);
    assert.equal(JSON.parse(badModel.text).error.code, "model_not_found");
});

// 非目标路径与非法 JSON 都要被拒绝。
test("an unsupported endpoint and invalid JSON are refused", async () => {
    const endpoint = await request(
        { model: "doubao-ai", messages: [{ role: "user", content: "Translate to Chinese: Hello" }] },
        { path: "/v1/embeddings", reply: echo() },
    );
    assert.equal(endpoint.response.status, 400);

    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => sseResponse([{ index: 0, res: "x" }]);
    try {
        const plugin = await DoubaoTranslatePlugin({}, {});
        const loader = await plugin.auth.loader(async () => AUTH);
        const response = await loader.fetch(`${BASE}/v1/chat/completions`, { method: "POST", body: "{" });
        assert.equal(response.status, 400);
        assert.equal(JSON.parse(await response.text()).error.code, "invalid_request");
    } finally {
        globalThis.fetch = realFetch;
    }
});
