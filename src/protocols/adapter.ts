// 请求适配层：把三种协议（OpenAI Chat Completions、OpenAI Responses、
// Anthropic Messages）的请求体统一翻译成内部的规范请求。
//
// 这一层只做翻译服务能支持的子集：多模态、工具调用、推理等能力一律显式拒绝，
// 避免客户端误以为拿到了完整模型能力。系统提示与 instructions 只用于读取目标
// 语言，不会作为内容送给豆包。

import { z } from "zod";
import { invalid } from "../core/errors.ts";
import { resolveModel } from "../core/models.ts";
import { determineLanguage, extractSource } from "../core/prompt-parser.ts";
import type { Language } from "../doubao/languages.ts";
import type { AdaptedRequest, Protocol } from "../types.ts";

// 三种协议共有的字段；passthrough 保留其余字段，交给 checkCapabilities 判断。
const baseSchema = z.object({
    model: z.string().min(1),
    stream: z.boolean().default(false),
    target_lang: z.string().optional(),
    doubao_scene: z.number().int().min(1).max(6).optional()
}).passthrough();
const messageSchema = z.object({
    role: z.string(),
    content: z.unknown(),
    type: z.string().optional()
}).passthrough();

// 判断客户端是否真的传了某个字段：false、空串、空数组、空对象都视为未传。
function hasValue(value: unknown): boolean {
    if (value == null || value === false || value === "") return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
}

function unsupported(param: string): never {
    throw invalid("Requested capability is not supported by this translation service.", "unsupported_feature", param);
}

// 翻译服务做不到的能力直接拒绝，并指明是哪个字段，方便客户端定位。
function checkCapabilities(body: Record<string, unknown>, protocol: Protocol): void {
    for (const key of [
        "tools",
        "functions",
        "function_call",
        "previous_response_id",
        "conversation",
        "reasoning",
        "reasoning_effort",
        "background",
        "audio",
        "prediction",
        "prompt"
    ]) {
        if (hasValue(body[key])) unsupported(key);
    }
    // tool_choice 的 "none" 等价于没传，只有真正要求调用工具才拒绝。
    for (const key of ["tool_choice"]) if (hasValue(body[key]) && body[key] !== "none") unsupported(key);
    if (hasValue(body.thinking) && (body.thinking as {type?: unknown} | undefined)?.type !== "disabled") unsupported("thinking");
    if (body.n !== undefined && body.n !== 1) unsupported("n");
    // modalities / response_format / text.format 需要看内部字段，先收窄成对象再判断。
    const modalities = body.modalities;
    if (hasValue(modalities) && (!Array.isArray(modalities) || modalities.some((x) => x !== "text"))) unsupported("modalities");
    const responseFormat = body.response_format as {type?: unknown} | undefined;
    if (hasValue(responseFormat) && responseFormat?.type !== "text") unsupported("response_format");
    if (protocol === "openai-responses" && hasValue(body.text)) {
        const format = (body.text as {format?: unknown}).format as {type?: unknown} | undefined;
        if (hasValue(format) && format?.type !== "text") unsupported("text.format");
    }
}

// 取出文本内容：既接受纯字符串，也接受内容块数组，但只允许纯文本块。
// nullable 用于 assistant 消息允许 content 为 null 的情况。
function textContent(value: unknown, acceptedTypes: string[], nullable = false): string {
    if (typeof value === "string") return value;
    if (value == null && nullable) return "";
    if (!Array.isArray(value)) throw invalid("Expected text content.", "unsupported_input", "content");
    return value.map((raw) => {
        const part = raw as {type?: unknown; text?: unknown} | null;
        if (!part || typeof part !== "object" || typeof part.type !== "string" || !acceptedTypes.includes(part.type))
            throw invalid("Only text input is supported.", "unsupported_input", "content");
        if (typeof part.text !== "string") throw invalid("Text content must be a string.");
        return part.text;
    }).join("");
}

// 校验失败时由 zod 给出 issues；这里只需要确认是数组且非空。
type ParsedMessage = {role: string; content: unknown; type?: string | undefined};

function messages(value: unknown): ParsedMessage[] {
    const parsed = z.array(messageSchema).min(1).safeParse(value);
    if (!parsed.success) throw invalid("A nonempty message list is required.", "invalid_request", "messages");
    return parsed.data;
}

// 遍历消息列表：把 system/developer 文本收集为 contexts（用于识别目标语言），
// 返回最后一条 user 文本作为待翻译正文。正文只取最后一条 user 消息，
// 因为翻译场景下多轮历史没有意义。
function fromMessages(items: ParsedMessage[], protocol: Protocol, contexts: string[]): string {
    let user: string | undefined;
    for (const message of items) {
        const roles = protocol === "anthropic" ? ["user", "assistant"] : ["system", "developer", "user", "assistant"];
        if (!roles.includes(message.role) || message.type !== undefined && message.type !== "message")
            throw invalid("Only text messages are supported.", "unsupported_input", "messages");
        // schema 保留多余字段，所以这里按记录访问消息上的可选能力字段。
        const extra = message as ParsedMessage & Record<string, unknown>;
        for (const key of ["tool_calls", "function_call", "audio"]) if (hasValue(extra[key])) unsupported(key);
        // 不同协议的内容块类型名不同，见 OpenAI Responses 与其余协议的差异。
        const types = protocol === "openai-responses" ? ["input_text", ...message.role === "assistant" ? ["output_text"] : []] : ["text"];
        const text = textContent(message.content, types, message.role === "assistant");
        if (message.role === "system" || message.role === "developer") contexts.push(text);
        if (message.role === "user") user = text;
    }
    if (user === undefined) throw invalid("A user text message is required.", "empty_translation_input");
    return user;
}

// 协议入口：校验 → 能力检查 → 取正文与语言 → 产出规范请求。
// 返回的 canonical 供翻译编排使用，instructions/includeUsage 供响应格式化使用。
export function adaptRequest(
    protocol: Protocol,
    input: unknown,
    headerLanguage: string | undefined,
    defaultScene: number,
    requestId: string,
    fallbackLanguage: Language | undefined
): AdaptedRequest {
    const parsed = baseSchema.safeParse(input);
    if (!parsed.success) {
        const param = parsed.error.issues[0]?.path.map(String).join(".") ?? null;
        throw invalid("Invalid request parameters.", "invalid_request", param);
    }
    // schema 用了 passthrough，未声明的字段也要能读到，因此按宽松记录类型使用。
    const body = parsed.data as Record<string, unknown> & typeof parsed.data;
    checkCapabilities(body, protocol);
    // contexts 收集所有「非正文」文本（系统提示、instructions），只用于语言识别。
    const contexts: string[] = [];
    let instructions: string | null = null;
    let user: string;
    if (protocol === "openai-responses") {
        if (body.instructions != null) {
            if (typeof body.instructions !== "string") throw invalid("Instructions must be text.", "invalid_request", "instructions");
            instructions = body.instructions;
            contexts.push(instructions);
        }
        // Responses 协议允许 input 直接是字符串，此时没有消息列表。
        user = typeof body.input === "string" ? body.input : fromMessages(messages(body.input), protocol, contexts);
    } else {
        // Anthropic 的系统提示在顶层 system 字段，不在 messages 里。
        if (protocol === "anthropic" && body.system != null) contexts.push(textContent(body.system, ["text"]));
        user = fromMessages(messages(body.messages), protocol, contexts);
    }
    const model = resolveModel(body.model);
    // 走完所有分支后 targetLang 一定已确定（normalizeLanguage 保证是规范代码）。
    const targetLang = determineLanguage(body.target_lang, headerLanguage, contexts, user, fallbackLanguage) as Language;
    const streamOptions = body.stream_options as {include_usage?: unknown} | undefined;
    return {
        canonical: {
            protocol,
            model,
            targetLang,
            // 从正文里剥掉指令前缀，只留真正要翻译的文本。
            rawText: extractSource(user),
            stream: body.stream,
            scene: body.doubao_scene ?? defaultScene,
            requestId
        },
        instructions,
        // 只有 OpenAI 流式协议显式要求时才额外发一个 usage 帧。
        includeUsage: streamOptions?.include_usage === true
    };
}
