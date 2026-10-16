// 协议适配与响应格式化单元测试。
// 覆盖 adaptRequest（三种协议请求体 → 内部规范请求）与 formatJSON / formatSSE（内部结果 → 协议响应）。
// 运行方式：npm test（或 node --test tests/protocols.test.ts）

import assert from "node:assert/strict";
import { test } from "node:test";

import { adaptRequest } from "../src/protocols/adapter.ts";
import { formatJSON, formatSSE } from "../src/protocols/format.ts";
import type { Language } from "../src/doubao/languages.ts";
import type { Protocol, TranslationResult } from "../src/types.ts";
import { at, serviceError } from "./helpers.ts";

// 适配层入口的默认参数：不指定请求头语言、默认场景 2、默认语言 zh。
interface AdaptOptions {
    header?: string;
    scene?: number;
    fallback?: Language;
}

const adapt = (protocol: Protocol, body: unknown, {header, scene = 2, fallback = "zh"}: AdaptOptions = {}) =>
    adaptRequest(protocol, body, header, scene, "req-1", fallback);

// 断言适配失败时的错误码与出错字段。
interface ExpectedFailure {
    code: string;
    param?: string | null;
    status?: number;
}

const fails = (protocol: Protocol, body: unknown, expected: ExpectedFailure): void => {
    let caught: unknown;
    try {
        adapt(protocol, body);
    } catch (error) {
        caught = error;
    }
    const error = serviceError(caught);
    assert.equal(error.code, expected.code);
    if (expected.param !== undefined) assert.equal(error.param, expected.param);
    if (expected.status !== undefined) assert.equal(error.status, expected.status);
};

// 预估用量时只关心 model 与 text，其余元信息补默认值即可。
const translated = (text: string, model = "doubao-ai"): TranslationResult => ({
    model,
    text,
    detectedLanguages: [],
    upstreamBatchCount: 1,
    elapsedMs: 0
});

const chat = (content: unknown, extra: Record<string, unknown> = {}) => ({model: "doubao-ai", messages: [{role: "user", content}], ...extra});

// ---------------------------------------------------------------- 请求校验

// model 与 messages 是必填项，错误要指明具体字段。
test("adaptRequest 校验必填字段并指出参数名", () => {
    fails("openai-chat", {messages: [{role: "user", content: "Translate to Chinese: Hello"}]}, {code: "invalid_request", param: "model"});
    fails("openai-chat", {model: 1, messages: []}, {code: "invalid_request", param: "model"});
    fails("openai-chat", {model: "doubao-ai", messages: []}, {code: "invalid_request", param: "messages"});
    fails("openai-chat", {model: "doubao-ai"}, {code: "invalid_request", param: "messages"});
    // 未知模型走 404。
    fails("openai-chat", chat("Translate to Chinese: Hello", {model: "nope"}), {code: "model_not_found", param: "model", status: 404});
});

// messages 里只接受已知角色与文本内容。
test("adaptRequest 拒绝非法消息", () => {
    fails("openai-chat", {model: "doubao-ai", messages: [{role: "tool", content: "x"}]}, {code: "unsupported_input", param: "messages"});
    fails("openai-chat", {model: "doubao-ai", messages: [{role: "user", type: "image", content: "x"}]}, {code: "unsupported_input", param: "messages"});
    // 只有 system / developer / user 之外没有 user 消息时也无法确定正文。
    fails("openai-chat", {model: "doubao-ai", messages: [{role: "system", content: "Translate to Chinese."}]}, {code: "empty_translation_input"});
});

// 只允许纯文本内容块，多模态输入明确拒绝。
test("adaptRequest 拒绝非文本内容块", () => {
    const body = chat([{type: "text", text: "Translate to Chinese: "}, {type: "image_url", image_url: {url: "x"}}]);
    fails("openai-chat", body, {code: "unsupported_input", param: "content"});
    // 文本块的 text 必须是字符串。
    fails("openai-chat", chat([{type: "text", text: 1}]), {code: "invalid_request"});
});

// 消息里带工具调用意味着客户端期望模型能力，翻译服务不支持。
test("adaptRequest 拒绝消息级工具调用", () => {
    fails("openai-chat", {model: "doubao-ai", messages: [{role: "user", content: "hi", tool_calls: [{id: "1"}]}]}, {code: "unsupported_feature", param: "tool_calls"});
    fails("openai-chat", {model: "doubao-ai", messages: [{role: "user", content: "hi", audio: {id: "1"}}]}, {code: "unsupported_feature", param: "audio"});
});

// 请求体级的能力字段一律拒绝，并指明字段名。
test("adaptRequest 拒绝请求体级不支持能力", () => {
    const cases: [string, unknown][] = [
        ["tools", [{type: "function"}]],
        ["functions", [{name: "f"}]],
        ["function_call", {name: "f"}],
        ["previous_response_id", "resp_1"],
        ["conversation", "conv_1"],
        ["reasoning", {effort: "low"}],
        ["reasoning_effort", "low"],
        ["background", true],
        ["audio", {voice: "x"}],
        ["prediction", {type: "content"}],
        ["prompt", {id: "p"}],
    ];
    for (const [key, value] of cases)
        fails("openai-chat", chat("Translate to Chinese: Hello", {[key]: value}), {code: "unsupported_feature", param: key});

    fails("openai-chat", chat("Translate to Chinese: Hello", {n: 2}), {code: "unsupported_feature", param: "n"});
    fails("openai-chat", chat("Translate to Chinese: Hello", {modalities: ["text", "audio"]}), {code: "unsupported_feature", param: "modalities"});
    fails("openai-chat", chat("Translate to Chinese: Hello", {response_format: {type: "json_object"}}), {code: "unsupported_feature", param: "response_format"});
    fails("openai-chat", chat("Translate to Chinese: Hello", {thinking: {type: "enabled"}}), {code: "unsupported_feature", param: "thinking"});
    fails("openai-chat", chat("Translate to Chinese: Hello", {tool_choice: "auto"}), {code: "unsupported_feature", param: "tool_choice"});
});

// false / 空串 / 空数组 / 空对象 / "none" 都视为「未传该能力」。
test("adaptRequest 把空值与 none 视为未启用", () => {
    const body = chat("Translate to Chinese: Hello", {
        tools: [],
        functions: [],
        tool_choice: "none",
        n: 1,
        modalities: ["text"],
        response_format: {type: "text"},
        thinking: {type: "disabled"},
        background: false,
        stream: false,
    });
    assert.equal(adapt("openai-chat", body).canonical.targetLang, "zh");
});

// Responses 协议的 text.format 只支持纯文本。
test("adaptRequest 校验 responses 的 text.format", () => {
    const base = {model: "doubao-ai", input: "Translate to Chinese: Hello"};
    assert.equal(adapt("openai-responses", {...base, text: {format: {type: "text"}}}).canonical.targetLang, "zh");
    fails("openai-responses", {...base, text: {format: {type: "json_schema"}}}, {code: "unsupported_feature", param: "text.format"});
});

// ---------------------------------------------------------------- 正文与语言

// Chat Completions：取最后一条 user 消息作为正文，system 用于识别语言。
test("adaptRequest 组装 chat 规范请求", () => {
    const {canonical, instructions, includeUsage} = adapt("openai-chat", {
        model: "volcengine-translate",
        stream: true,
        messages: [
            {role: "system", content: "Translate to Japanese."},
            {role: "user", content: "Hello"},
        ],
    });
    assert.deepEqual(canonical, {
        protocol: "openai-chat",
        model: "volcengine-translate",
        targetLang: "ja",
        rawText: "Hello",
        stream: true,
        scene: 2,
        requestId: "req-1",
    });
    // Chat 协议没有 instructions 概念，默认不补 usage 帧。
    assert.equal(instructions, null);
    assert.equal(includeUsage, false);
});

// 多条 user 消息只取最后一条：翻译场景下历史没有意义。
test("adaptRequest 只取最后一条 user 消息", () => {
    const {canonical} = adapt("openai-chat", {
        model: "doubao-ai",
        messages: [
            {role: "user", content: "Translate to Chinese: first"},
            {role: "assistant", content: "第一次译文"},
            {role: "user", content: "Translate to Chinese: second"},
        ],
    });
    assert.equal(canonical.rawText, "second");
    // assistant 消息的 content 允许为 null。
    assert.equal(adapt("openai-chat", {
        model: "doubao-ai",
        messages: [{role: "assistant", content: null}, {role: "user", content: "Translate to Chinese: Hi"}],
    }).canonical.rawText, "Hi");
});

// 内容块数组会拼接成一段正文。
test("adaptRequest 拼接文本内容块", () => {
    const {canonical} = adapt("openai-chat", chat([
        {type: "text", text: "Translate to Chinese: "},
        {type: "text", text: "Hello world"},
    ]));
    assert.equal(canonical.rawText, "Hello world");
});

// Anthropic：system 是顶层字段，只用于识别语言，不进正文。
test("adaptRequest 处理 anthropic 的顶层 system", () => {
    const {canonical} = adapt("anthropic", {
        model: "doubao-ai",
        system: "Translate to German.",
        messages: [{role: "user", content: "Hello"}],
    });
    assert.equal(canonical.targetLang, "de");
    assert.equal(canonical.rawText, "Hello");
    // messages 里出现 system 角色是非法的，anthropic 只允许 user / assistant。
    fails("anthropic", {
        model: "doubao-ai",
        messages: [{role: "system", content: "Translate to German."}, {role: "user", content: "Hello"}],
    }, {code: "unsupported_input", param: "messages"});
});

// Responses：instructions 记入上下文且原样回传，input 可以是字符串或消息数组。
test("adaptRequest 处理 responses 的 instructions", () => {
    const text = adapt("openai-responses", {model: "doubao-ai", instructions: "Translate to Spanish.", input: "Hello"});
    assert.equal(text.canonical.rawText, "Hello");
    assert.equal(text.canonical.targetLang, "es");
    assert.equal(text.instructions, "Translate to Spanish.");

    const list = adapt("openai-responses", {
        model: "doubao-ai",
        input: [{role: "user", content: [{type: "input_text", text: "Translate to Spanish: Hello"}]}],
    });
    assert.equal(list.canonical.rawText, "Hello");
    assert.equal(list.instructions, null);
    // instructions 必须是文本。
    fails("openai-responses", {model: "doubao-ai", instructions: {text: "x"}, input: "Hello"}, {code: "invalid_request", param: "instructions"});
});

// 请求头语言、doubao_scene、stream_options 都要正确落到规范请求上。
test("adaptRequest 处理请求头语言、场景与 usage 开关", () => {
    const {canonical} = adapt("openai-chat", chat("Hello"), {header: "ko", scene: 5});
    assert.equal(canonical.targetLang, "ko");
    assert.equal(canonical.scene, 5);
    // 请求体里的 doubao_scene 覆盖默认值。
    assert.equal(adapt("openai-chat", chat("Translate to Chinese: Hello", {doubao_scene: 3})).canonical.scene, 3);
    // 只有显式要求时才补 usage 帧。
    assert.equal(adapt("openai-chat", chat("Translate to Chinese: Hello", {stream_options: {include_usage: true}})).includeUsage, true);
});

// 未指定语言时用插件默认语言；指令里写了语言则优先于默认值。
test("adaptRequest 支持默认语言回退", () => {
    assert.equal(adapt("openai-chat", chat("Hello"), {fallback: "fr"}).canonical.targetLang, "fr");
    assert.equal(adapt("openai-chat", chat("Translate to Japanese: Hello"), {fallback: "fr"}).canonical.targetLang, "ja");
});

// ---------------------------------------------------------------- formatJSON

// 估算 usage：约 4 个 ASCII 字符 1 token，非 ASCII 按 1 字符 1 token。
test("formatJSON 按文本估算 token 用量", () => {
    const adapted = adapt("openai-chat", chat("Translate to Chinese: abcd"));
    const result = translated("你好");
    const payload = formatJSON("openai-chat", result, adapted);
    assert.deepEqual(payload.usage, {prompt_tokens: 1, completion_tokens: 2, total_tokens: 3});
});

// Chat Completions 非流式响应结构。
test("formatJSON 输出 chat 完成体", () => {
    const adapted = adapt("openai-chat", chat("Translate to Chinese: Hello"));
    const payload = formatJSON("openai-chat", translated("你好"), adapted);
    assert.match(payload.id, /^chatcmpl_[0-9a-f]{32}$/);
    assert.equal(payload.object, "chat.completion");
    assert.equal(payload.model, "doubao-ai");
    assert.deepEqual(payload.choices, [{index: 0, message: {role: "assistant", content: "你好"}, finish_reason: "stop"}]);
    assert.equal(payload.usage.total_tokens, payload.usage.prompt_tokens + payload.usage.completion_tokens);
    assert.equal(typeof payload.created, "number");
});

// Anthropic 非流式响应结构（usage 只含输入输出两项）。
test("formatJSON 输出 anthropic 消息体", () => {
    const adapted = adapt("anthropic", {model: "doubao-ai", system: "Translate to Chinese.", messages: [{role: "user", content: "Hello"}]});
    const payload = formatJSON("anthropic", translated("你好"), adapted);
    assert.match(payload.id, /^msg_[0-9a-f]{32}$/);
    assert.equal(payload.type, "message");
    assert.equal(payload.role, "assistant");
    assert.equal(payload.stop_reason, "end_turn");
    assert.equal(payload.stop_sequence, null);
    assert.deepEqual(payload.content, [{type: "text", text: "你好"}]);
    assert.deepEqual(Object.keys(payload.usage).sort(), ["input_tokens", "output_tokens"]);
});

// Responses 非流式响应结构，含占位字段与 usage 明细。
test("formatJSON 输出 responses 完成体", () => {
    const adapted = adapt("openai-responses", {model: "doubao-ai", instructions: "Translate to Chinese.", input: "Hello"});
    const payload = formatJSON("openai-responses", translated("你好"), adapted);
    assert.equal(payload.object, "response");
    assert.equal(payload.status, "completed");
    assert.equal(payload.instructions, "Translate to Chinese.");
    assert.deepEqual(payload.output[0].content[0], {type: "output_text", text: "你好", annotations: [], logprobs: []});
    assert.deepEqual(payload.usage.input_tokens_details, {cached_tokens: 0});
    assert.deepEqual(payload.usage.output_tokens_details, {reasoning_tokens: 0});
    // 这些字段在协议里是必填项，本服务不做工具调用故填默认值。
    assert.deepEqual(payload.tools, []);
    assert.equal(payload.tool_choice, "none");
    assert.equal(payload.parallel_tool_calls, false);
    assert.equal(payload.store, false);
    assert.equal(payload.completed_at, payload.created_at);
});

// ---------------------------------------------------------------- formatSSE

// 把 SSE 文本解析成 [{event, data}]，便于断言事件序列。
function parseFrames(text: string): {event: string | null; data: string}[] {
    return text.split("\n\n").filter(Boolean).map((block) => {
        const lines = block.split("\n");
        const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? null;
        const data = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        return {event, data};
    });
}

// Chat Completions 流式：角色帧 → 内容帧 → 结束帧 → 可选的 usage 帧 → [DONE]。
test("formatSSE 输出 chat 事件序列", () => {
    const adapted = adapt("openai-chat", chat("Translate to Chinese: Hello", {stream: true}));
    const result = translated("你好");

    const frames = parseFrames(formatSSE("openai-chat", result, adapted));
    // 3 个数据块（角色 / 内容 / 结束原因）+ 结尾的 [DONE]。
    assert.equal(frames.length, 4);
    assert.deepEqual(frames.map((frame) => frame.event), [null, null, null, null]);
    assert.deepEqual(JSON.parse(at(frames, 0).data).choices[0].delta, {role: "assistant", content: ""});
    assert.equal(JSON.parse(at(frames, 1).data).choices[0].delta.content, "你好");
    assert.equal(JSON.parse(at(frames, 2).data).choices[0].finish_reason, "stop");
    // 所有数据帧共用同一个响应 id。
    const ids = new Set(frames.slice(0, 3).map((frame) => JSON.parse(frame.data).id));
    assert.equal(ids.size, 1);
    assert.match(at(frames, 0).data, /"object":"chat\.completion\.chunk"/);
    assert.equal(at(frames, -1).data, "[DONE]");

    // 未要求 usage 时不应出现 usage 帧。
    assert.doesNotMatch(formatSSE("openai-chat", result, adapted), /"usage"/);

    const withUsage = adapt("openai-chat", chat("Translate to Chinese: Hello", {stream: true, stream_options: {include_usage: true}}));
    const usageFrames = parseFrames(formatSSE("openai-chat", result, withUsage));
    // 额外插入一个 usage 帧，其余时序不变。
    assert.equal(usageFrames.length, 5);
    const last = JSON.parse(at(usageFrames, -2).data);
    assert.deepEqual(last.choices, []);
    assert.equal(last.usage.total_tokens, 4);
});

// Anthropic 流式：6 个命名事件的固定生命周期。
test("formatSSE 输出 anthropic 事件序列", () => {
    const adapted = adapt("anthropic", {model: "doubao-ai", system: "Translate to Chinese.", messages: [{role: "user", content: "Hello"}]});
    const frames = parseFrames(formatSSE("anthropic", translated("你好"), adapted));
    assert.deepEqual(frames.map((frame) => frame.event), [
        "message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"
    ]);
    for (const frame of frames) assert.equal(JSON.parse(frame.data).type, frame.event);
    const delta = JSON.parse(at(frames, 2).data);
    assert.deepEqual(delta.delta, {type: "text_delta", text: "你好"});
    assert.equal(delta.index, 0);
    // 起始事件带空内容，结束事件带 stop_reason。
    assert.deepEqual(JSON.parse(at(frames, 0).data).message.content, []);
    assert.deepEqual(JSON.parse(at(frames, 4).data).delta, {stop_reason: "end_turn", stop_sequence: null});
});

// Responses 流式：9 个事件且 sequence_number 从 0 自增。
test("formatSSE 输出 responses 事件序列", () => {
    const adapted = adapt("openai-responses", {model: "doubao-ai", input: "Translate to Chinese: Hello", stream: true});
    const frames = parseFrames(formatSSE("openai-responses", translated("你好"), adapted));
    assert.deepEqual(frames.map((frame) => frame.event), [
        "response.created", "response.in_progress", "response.output_item.added", "response.content_part.added",
        "response.output_text.delta", "response.output_text.done", "response.content_part.done",
        "response.output_item.done", "response.completed"
    ]);
    frames.forEach((frame, i) => {
        const data = JSON.parse(frame.data);
        // 事件名与 type 字段一致，序号严格自增。
        assert.equal(data.type, frame.event);
        assert.equal(data.sequence_number, i);
    });
    assert.equal(JSON.parse(at(frames, 4).data).delta, "你好");
    // 定位信息固定为第一个 item / 第一个 content part。
    const delta = JSON.parse(at(frames, 4).data);
    assert.equal(delta.output_index, 0);
    assert.equal(delta.content_index, 0);
    assert.match(delta.item_id, /^msg_/);
    // 完成事件里的 response 带最终文本与 usage。
    const completed = JSON.parse(at(frames, -1).data).response;
    assert.equal(completed.status, "completed");
    assert.equal(completed.output[0].content[0].text, "你好");
    // "Hello" 估 2 token，"你好" 估 2 token。
    assert.deepEqual(completed.usage, {
        input_tokens: 2,
        input_tokens_details: {cached_tokens: 0},
        output_tokens: 2,
        output_tokens_details: {reasoning_tokens: 0},
        total_tokens: 4
    });
    // 起始事件是进行中状态，且没有已完成产物。
    const created = JSON.parse(at(frames, 0).data).response;
    assert.equal(created.status, "in_progress");
    assert.equal(created.completed_at, null);
    assert.deepEqual(created.output, []);
    assert.equal(created.usage, null);
});
