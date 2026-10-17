// Magpie 插件入口。
//
// 负责三件事：
//   1. 注册 doubao-translate 供应商与模型列表
//   2. 提供 Cookie 登录流程（校验后保存，后续请求由宿主注入）
//   3. 实现 loader.fetch，把三种兼容协议的请求转到豆包翻译接口
//
// 豆包只是翻译服务，所以这里把 OpenAI / Anthropic 的通用模型接口收窄成翻译接口，
// 不支持的请求能力会明确返回错误。

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { loadProviderIcon } from "../assets.ts";
import { ServiceError, asServiceError, invalid } from "../core/errors.ts";
import { Translator } from "../core/translator.ts";
import { models } from "../core/models.ts";
import { DoubaoClient } from "../doubao/client.ts";
import { normalizeLanguage } from "../doubao/languages.ts";
import { importCookie } from "../admin/accounts.ts";
import { loadConfig } from "../config/env.ts";
import { adaptRequest } from "../protocols/adapter.ts";
import { formatJSON, formatSSE } from "../protocols/format.ts";
import type { FetchInput, HostAuth, HostConfig, HostLoginResult, HostModel, HostProvider, MagpiePlugin, Protocol, StoredCookie } from "../types.ts";

const PROVIDER = "doubao-translate";
// 插件在宿主内直接处理请求，这个域名不会真的被访问；作用只是给 SDK 一个
// 合法的 baseURL，让请求落到下面的 fetch 实现里。
const BASE = "https://doubao-translate.invalid/v1";
// 请求体大小上限。
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
// 模型对外声明的上下文与输出预算，是网关侧的保守值，不代表豆包套餐额度。
const MODEL_CONTEXT_LIMIT = 32_000;

const positiveInt = z.number().int().positive();
// 插件选项 schema；未知字段直接报错，避免拼写错误被静默忽略。
const optionsSchema = z.object({
    targetLang: z.string().default("zh").refine((value) => {
        try {
            normalizeLanguage(value);
            return true;
        } catch {
            return false;
        }
    }, "Unsupported target language.").transform(normalizeLanguage),
    scene: positiveInt.max(6).default(2),
    maxConcurrency: positiveInt.max(1_000).default(4),
    requestTimeoutMs: positiveInt.default(45_000),
    totalTimeoutMs: positiveInt.default(180_000),
    authTimeoutMs: positiveInt.default(10_000),
    maxRetries: z.number().int().min(0).max(10).default(0),
    queueMax: z.number().int().min(0).default(100),
    queueTimeoutMs: positiveInt.default(30_000)
}).strict();

// 从宿主提供的登录凭据里取出并解析 Cookie。
// 凭据里存的就是 Cookie 本身，没有额外的 API Key。
function cookieFor(auth: HostAuth | undefined): StoredCookie {
    if (auth?.type !== "api" || !auth.key)
        throw new ServiceError("cookie_missing", 401, "Sign in with your Doubao Cookie first.");
    try {
        return importCookie(auth.key);
    } catch {
        // 已保存的 Cookie 解析失败，说明它已不可用，标记为需要重新登录。
        throw Object.assign(
            new ServiceError("cookie_invalid", 401, "Doubao Cookie is invalid. Sign in again."),
            {signIn: "expired"}
        );
    }
}

// 这几种错误都表示「需要重新登录」，而不只是这一次请求失败。
function expired(error: ServiceError): boolean {
    return ["cookie_missing", "cookie_invalid", "upstream_auth_error"].includes(error.code);
}

// 把内部错误渲染成对应协议的错误响应。
// 登录失效统一转成 401 并带上 X-Magpie-Sign-In 头，宿主据此提示重新登录；
// 上游 429 原样保留，其余按状态码映射到协议约定的错误类型。
function failure(error: unknown, protocol: Protocol | undefined): Response {
    const value = asServiceError(error);
    const isExpired = expired(value);
    const status = isExpired ? 401 : value.upstreamStatus === 429 ? 429 : value.status;
    const type = isExpired ? "authentication_error" : status === 429 ? "rate_limit_error" : status < 500 ? "invalid_request_error" : "api_error";
    // Anthropic 与 OpenAI 的错误体结构不同，分别构造。
    return Response.json(protocol === "anthropic" ? {
        type: "error",
        error: {type, message: value.message}
    } : {error: {message: value.message, type, code: value.code, param: value.param}}, {
        status,
        headers: isExpired ? {"X-Magpie-Sign-In": "expired"} : {}
    });
}

export const DoubaoTranslatePlugin = async (_input: unknown, rawOptions: unknown): Promise<MagpiePlugin> => {
    const parsed = optionsSchema.safeParse(rawOptions ?? {});
    if (!parsed.success) throw new Error("Invalid Doubao plugin options: " + parsed.error.issues.map((issue) => issue.path.join(".") || "options").join(", "));
    const options = parsed.data;
    // 图标内嵌返回，本机与远端安装都能立即显示，无需额外下载。
    const icon = await loadProviderIcon();
    // 用插件选项拼出翻译核心需要的配置，复用与 API 服务版相同的代码路径。
    const config = loadConfig({
        ADMIN_ENABLED: "false",
        ALLOW_NO_AUTH: "true",
        DOUBAO_DEFAULT_TARGET_LANG: options.targetLang,
        DOUBAO_DEFAULT_SCENE: String(options.scene),
        DOUBAO_MAX_CONCURRENCY: String(options.maxConcurrency),
        DOUBAO_REQUEST_TIMEOUT_MS: String(options.requestTimeoutMs),
        DOUBAO_TOTAL_TIMEOUT_MS: String(options.totalTimeoutMs),
        DOUBAO_AUTH_TIMEOUT_MS: String(options.authTimeoutMs),
        DOUBAO_MAX_RETRIES: String(options.maxRetries),
        DOUBAO_QUEUE_MAX: String(options.queueMax),
        DOUBAO_QUEUE_TIMEOUT_MS: String(options.queueTimeoutMs)
    });
    // 插件版不使用账号池：账号与故障切换交给 Magpie 宿主管理。
    const client = new DoubaoClient(config);
    const translator = new Translator(config, client);
    const defaultModels: Record<string, HostModel> = Object.fromEntries(models.map((model) => [model.id, {
        name: model.display_name,
        limit: {context: MODEL_CONTEXT_LIMIT, output: MODEL_CONTEXT_LIMIT},
        tool_call: false,
        reasoning: false,
        modalities: {input: ["text"], output: ["text"]}
    }]));

    // 校验 Cookie 在豆包侧是否仍然有效，成功时返回解析后的 Cookie。
    // 登录失效标记 signIn=expired 让宿主引导重新登录；网络类失败只提示稍后重试，
    // 避免把临时故障误判成需要重新登录。
    async function inspect(getAuth: () => Promise<HostAuth>): Promise<StoredCookie> {
        const cookie = cookieFor(await getAuth());
        const status = await translator.authStatus(new AbortController().signal, async () => cookie);
        if (!status.authenticated) {
            // 明确的登录问题才算需要重新登录；上游返回其他业务码时只当作校验失败。
            const refused = status.reason === "cookie_expired" || status.reason === "cookie_invalid" || status.reason === "upstream_auth_error" && status.upstream_code === undefined;
            const error = new ServiceError(
                status.reason ?? "upstream_auth_error",
                502,
                refused ? "Doubao login has expired. Sign in again with a new Cookie." : "Could not verify Doubao login. Try again later."
            );
            // 明确的登录问题才标记 signIn，宿主据此引导用户重新登录。
            if (refused) error.signIn = "expired";
            throw error;
        }
        return cookie;
    }

    return {
        // 注册供应商：走 OpenAI 兼容的 SDK，但实际请求由下面的 fetch 接管。
        config: async (cfg: HostConfig): Promise<void> => {
            cfg.provider ??= {};
            cfg.provider[PROVIDER] ??= {
                name: "Doubao Translation",
                npm: "@ai-sdk/openai-compatible",
                api: BASE,
                models: defaultModels
            };
        },
        auth: {
            provider: PROVIDER,
            icon,
            maxConcurrency: options.maxConcurrency,
            methods: [{
                // 用自定义登录流程，让宿主直接保存 Cookie，不再额外索要 API Key。
                type: "oauth",
                label: "Import Doubao Cookie",
                prompts: [
                    {
                        type: "text",
                        key: "cookie",
                        message: "Doubao Cookie Header or exported JSON",
                        // 输入即校验，尽早拦住格式不对的 Cookie。
                        validate: (value: string): string | undefined => {
                            try {
                                importCookie(value);
                            } catch {
                                return "Cookie must include sessionid, sid_tt and uid_tt.";
                            }
                            return undefined;
                        }
                    },
                    {type: "text", key: "name", message: "Account name (optional)"}
                ],
                async authorize(inputs: Record<string, string> | undefined) {
                    return {
                        // 纯手工粘贴，没有需要打开的授权页。
                        url: "",
                        instructions: "Checking your Doubao Cookie.",
                        method: "auto",
                        async callback(): Promise<HostLoginResult | {type: "failed"; error: string}> {
                            try {
                                const cookie = importCookie(inputs?.cookie ?? "");
                                // 保存前先确认 Cookie 在豆包侧可用。
                                await inspect(async () => ({type: "api", key: cookie.cookie}));
                                // 用 uid_tt 的摘要生成账号指纹，仅用于在列表里区分账号，
                                // 不会暴露 Cookie 本身。
                                // importCookie 已确认三项齐全，因此 uid_tt 一定存在。
                                const uid = cookie.cookie.split(";").map((value) => value.trim()).find((value) => value.startsWith("uid_tt=")) ?? "";
                                const fingerprint = createHash("sha256").update(uid).digest("hex").slice(0, 12);
                                return {
                                    type: "success",
                                    key: cookie.cookie,
                                    metadata: {email: `${inputs?.name?.trim().slice(0, 64) || "Doubao"} (${fingerprint})`}
                                };
                            } catch (error) {
                                return {type: "failed", error: asServiceError(error).message};
                            }
                        }
                    };
                }
            }],
            // 返回给 SDK 的加载器；真正的翻译逻辑都在 fetch 里。
            async loader(getAuth: () => Promise<HostAuth>) {
                return {
                    baseURL: BASE,
                    // 占位值：Cookie 通过请求头单独传递，绝不能放进 Authorization。
                    apiKey: "doubao-translate-local",
                    async fetch(input: FetchInput, init?: RequestInit): Promise<Response> {
                        const request = new Request(input, init);
                        const url = new URL(request.url);
                        // 路径决定使用哪套协议适配与响应格式。
                        const protocol = {
                            "/v1/chat/completions": "openai-chat",
                            "/v1/responses": "openai-responses",
                            "/v1/messages": "anthropic"
                        }[url.pathname] as Protocol | undefined;
                        try {
                            request.signal.throwIfAborted();
                            // 只接受发往本插件 baseURL 的 POST 请求。
                            if (url.origin !== new URL(BASE).origin || request.method !== "POST" || !protocol)
                                throw invalid("Unsupported translation endpoint.");
                            const text = await request.text();
                            if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) throw new ServiceError("request_too_large", 413, "Translation request is too large.");
                            let body: unknown;
                            try {
                                body = JSON.parse(text);
                            } catch {
                                throw invalid("Invalid request JSON.");
                            }
                            // 协议适配：校验参数、拒绝不支持的能力、解析语言与正文。
                            const adapted = adaptRequest(
                                protocol,
                                body,
                                request.headers.get("x-doubao-target-lang") ?? undefined,
                                options.scene,
                                randomUUID(),
                                options.targetLang
                            );
                            const cookie = cookieFor(await getAuth());
                            const result = await translator.translate(adapted.canonical, request.signal, async () => cookie);
                            // 流式请求返回 SSE，非流式返回 JSON。
                            if (adapted.canonical.stream) return new Response(formatSSE(protocol, result, adapted), {
                                headers: {
                                    "Content-Type": "text/event-stream; charset=utf-8",
                                    "Cache-Control": "no-cache"
                                }
                            });
                            return Response.json(formatJSON(protocol, result, adapted));
                        } catch (error) {
                            // 客户端主动取消时直接把中断原因抛出去，不包装成错误响应。
                            if (request.signal.aborted) throw request.signal.reason;
                            return failure(error, protocol);
                        }
                    }
                };
            }
        },
        provider: {
            id: PROVIDER,
            // 宿主查询模型列表时顺带校验一次登录，便于在界面上提示状态。
            async models(provider: HostProvider, context: {auth?: HostAuth | undefined} = {}): Promise<Record<string, HostModel>> {
                const auth = context.auth;
                if (auth?.type === "api") await inspect(async () => auth);
                return provider.models;
            }
        }
    };
};
