// 响应格式化层：把翻译结果渲染成三种协议各自的 JSON 或 SSE 负载。
//
// 豆包网页接口不返回 token 用量，所以 usage 是按文本估算的（见 estimateTokens），
// 只用于 Magpie 的展示与统计，不代表上游真实计数或套餐额度。

import { randomUUID } from "node:crypto";
import type { AdaptedRequest, JsonPayload, Protocol, TranslationResult } from "../types.ts";

// 各协议的 id 前缀不同，这里统一生成。
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;

// 按 Magpie 自身的提示词估算规则从文本估算 token：
// 约四个 ASCII 字符一个 token，其余字符（主要是 CJK）一个字符一个 token。
function estimateTokens(text: string): number {
    let ascii = 0;
    let other = 0;
    for (const char of text) {
        // 按码点遍历，避免 emoji 等代理对被算成两个字符。
        const code = char.codePointAt(0);
        if (code !== undefined && code < 128) ascii++;
        else other++;
    }
    return Math.ceil(ascii / 4) + other;
}

// Chat Completions 的 usage 字段命名。
const usageChat = (input: number, output: number) => ({
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output
});

// Responses 的 usage 字段命名，结构与 Chat Completions 不同。
const usageResponses = (input: number, output: number) => ({
    input_tokens: input,
    input_tokens_details: {cached_tokens: 0},
    output_tokens: output,
    output_tokens_details: {reasoning_tokens: 0},
    total_tokens: input + output
});
// Responses 协议里文本块的固定形状。
const textPart = (text: string) => ({type: "output_text", text, annotations: [], logprobs: []});

// 非流式响应：按协议产出完整 JSON。
export function formatJSON(protocol: Protocol, result: TranslationResult, adapted: AdaptedRequest): JsonPayload {
    const created = Math.floor(Date.now() / 1_000);
    // 输入按原文估算，输出按译文估算。
    const input = estimateTokens(adapted.canonical.rawText);
    const output = estimateTokens(result.text);
    if (protocol === "openai-chat") return {
        id: id("chatcmpl"),
        object: "chat.completion",
        created,
        model: result.model,
        choices: [{index: 0, message: {role: "assistant", content: result.text}, finish_reason: "stop"}],
        usage: usageChat(input, output)
    };
    if (protocol === "anthropic") return {
        id: id("msg"),
        type: "message",
        role: "assistant",
        model: result.model,
        content: [{type: "text", text: result.text}],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {input_tokens: input, output_tokens: output}
    };
    return {
        id: id("resp"),
        object: "response",
        created_at: created,
        completed_at: created,
        status: "completed",
        error: null,
        incomplete_details: null,
        instructions: adapted.instructions,
        model: result.model,
        output: [{
            id: id("msg"),
            type: "message",
            status: "completed",
            role: "assistant",
            content: [textPart(result.text)]
        }],
        usage: usageResponses(input, output),
        // Responses 协议要求这些字段存在，本服务不做工具调用，全部填默认值。
        tools: [],
        tool_choice: "none",
        parallel_tool_calls: false,
        previous_response_id: null,
        max_output_tokens: null,
        temperature: null,
        top_p: null,
        reasoning: null,
        text: {format: {type: "text"}},
        truncation: "disabled",
        metadata: {},
        store: false
    };
}

// 流式响应：豆包本身返回的是完整译文而非增量，因此这里把结果拆成协议要求的
// 事件序列一次性发出，保证客户端能按标准事件流解析。
export function formatSSE(protocol: Protocol, result: TranslationResult, adapted: AdaptedRequest): string {
    const complete = formatJSON(protocol, result, adapted);
    const frames: string[] = [];
    // 每个 SSE 帧形如 "event: X\ndata: {...}\n\n"，无 event 名时省略该行。
    const emit = (value: unknown, event?: string) => {
        frames.push(`${event ? `event: ${event}
` : ""}data: ${JSON.stringify(value)}

`);
    };
    if (protocol === "openai-chat") {
        const chunk = (delta: unknown, finish: string | null) => ({
            id: complete.id,
            object: "chat.completion.chunk",
            created: complete.created,
            model: result.model,
            choices: [{index: 0, delta, finish_reason: finish}]
        });
        // 标准时序：先发角色，再发内容，最后发结束原因与 [DONE]。
        emit(chunk({role: "assistant", content: ""}, null));
        emit(chunk({content: result.text}, null));
        emit(chunk({}, "stop"));
        // 仅当客户端在 stream_options 里要求时才补一个 usage 帧。
        if (adapted.includeUsage) emit({
            id: complete.id,
            object: "chat.completion.chunk",
            created: complete.created,
            model: result.model,
            choices: [],
            usage: complete.usage
        });
        frames.push("data: [DONE]\n\n");
    } else if (protocol === "anthropic") {
        // Anthropic 用命名事件描述消息生命周期，起止事件都要带上消息骨架。
        emit({type: "message_start", message: {...complete, content: [], stop_reason: null}}, "message_start");
        emit({type: "content_block_start", index: 0, content_block: {type: "text", text: ""}}, "content_block_start");
        emit({
            type: "content_block_delta",
            index: 0,
            delta: {type: "text_delta", text: result.text}
        }, "content_block_delta");
        emit({type: "content_block_stop", index: 0}, "content_block_stop");
        emit({
            type: "message_delta",
            delta: {stop_reason: "end_turn", stop_sequence: null},
            usage: {output_tokens: complete.usage.output_tokens}
        }, "message_delta");
        emit({type: "message_stop"}, "message_stop");
    } else {
        // Responses 事件带自增 sequence_number，且事件名与 type 字段一致。
        let sequence = 0;
        const event = (type: string, fields: Record<string, unknown>) => emit({type, ...fields, sequence_number: sequence++}, type);
        // output 与 content 一定有第一个元素：formatJSON 刚构造过它们。
        const outputItem = (complete.output as JsonPayload[])[0] as JsonPayload;
        const part = (outputItem.content as JsonPayload[])[0] as JsonPayload;
        // 片段定位信息：item_id + output_index + content_index。
        const indexes = {item_id: outputItem.id, output_index: 0, content_index: 0};
        // 起始事件里的 response 是「进行中」状态，与最终完成态不同。
        const initial = {...complete, status: "in_progress", completed_at: null, output: [], usage: null};
        event("response.created", {response: initial});
        event("response.in_progress", {response: initial});
        event("response.output_item.added", {
            output_index: 0,
            item: {...outputItem, status: "in_progress", content: []}
        });
        event("response.content_part.added", {...indexes, part: textPart("")});
        // 文本增量：豆包一次性返回全文，所以只有一个 delta。
        event("response.output_text.delta", {...indexes, delta: result.text, logprobs: []});
        event("response.output_text.done", {...indexes, text: result.text, logprobs: []});
        event("response.content_part.done", {...indexes, part});
        event("response.output_item.done", {output_index: 0, item: outputItem});
        event("response.completed", {response: complete});
    }
    return frames.join("");
}
