// 豆包网页客户端。
//
// 调用的是豆包网页版自用的流式翻译接口，响应可能是 SSE 也可能是普通 JSON，
// 这里统一解析并把上游错误码归一成 ServiceError，供重试 / 故障切换判断。

import { ServiceError } from "../core/errors.ts";
import { loadCookie } from "../auth/cookie-store.ts";
import { SSEParser } from "./sse-parser.ts";
import type { AuthStatus, CookieProvider, StoredCookie, UpstreamTranslateRequest, UpstreamTranslateResult } from "../types.ts";
import type { EnvConfig } from "../config/env.ts";

const ORIGIN = "https://www.doubao.com";
// Bun doesn't add a User-Agent on its own. Doubao's CDN then answers an empty
// 200 text/plain response, so every request must carry one explicitly.
const DEFAULT_USER_AGENT = "Mozilla/5.0";
// 响应体大小上限，防止异常上游把内存撑爆。
const MAX_BODY = 8 * 1024 * 1024;
// 上游业务错误码 -> 本服务错误码。未列出的错误码按可重试的流错误处理。
const knownCodes: Record<number, string> = {
    710012001: "upstream_auth_error",
    710010202: "upstream_bad_request",
    710020202: "upstream_bad_request",
    710020702: "upstream_stream_error"
};

// 已知错误码不可重试（重试也没用），未知错误码按可重试处理。
function businessError(code: number): ServiceError {
    return new ServiceError(
        knownCodes[code] ?? "upstream_stream_error",
        502,
        code === 710012001 ? "Upstream login has expired." : "Upstream translation failed.",
        !Object.hasOwn(knownCodes, code),
        null,
        code
    );
}

// 豆包可能返回非 JSON（如 HTML 错误页），统一当作流错误。
function parseJSON(text: string): Record<string, unknown> {
    try {
        const value = JSON.parse(text);
        if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
    }
    throw new ServiceError("upstream_stream_error", 502, "Invalid upstream response.");
}

// 上游用 code === 0 表示成功。
function checkCode(value: {code?: unknown}): void {
    if (typeof value.code === "number" && value.code !== 0) throw businessError(value.code);
}

// 豆包 translate_service 的请求体格式。
function buildRequestBody(req: UpstreamTranslateRequest): Record<string, unknown> {
    return {
        raw_text: req.texts,
        target_lang: req.targetLang,
        translate_service: req.engine,
        scene: req.scene,
        frontend_source: 1
    };
}

// 上游数据帧里的一条分段译文：字段都当作未知，逐项校验后再使用。
interface UpstreamItem {
    index?: unknown;
    res?: unknown;
    detect_lang?: unknown;
}

export class DoubaoClient {
    readonly config: EnvConfig;
    // 网络与日志出口可注入，便于测试。
    readonly fetcher: typeof fetch;
    readonly warn: (name: string, detail?: unknown) => void;

    // fetcher / warn 可注入，便于测试与替换日志出口。
    constructor(
        config: EnvConfig,
        fetcher: typeof fetch = fetch,
        warn: (name: string, detail?: unknown) => void = () => {
        }
    ) {
        this.config = config;
        this.fetcher = fetcher;
        this.warn = warn;
    }

    // 统一的带 Cookie 请求：合并调用方信号与超时，并处理 HTTP 层错误。
    // suppliedCookie 未提供时从配置文件读取（仅独立服务版会走到）。
    async request(
        path: string,
        signal: AbortSignal,
        init: RequestInit,
        timeout: number,
        suppliedCookie?: StoredCookie
    ): Promise<{response: Response; combined: AbortSignal}> {
        const {cookie, complete} = suppliedCookie ?? await loadCookie(this.config.DOUBAO_COOKIE_FILE);
        if (!complete) throw new ServiceError("cookie_invalid", 502, "Required login cookies are missing.");
        // 调用方取消或超时任一触发都要中断请求。
        const combined = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
        const headers = new Headers(init.headers);
        headers.set("Cookie", cookie);
        headers.set("User-Agent", this.config.DOUBAO_USER_AGENT || DEFAULT_USER_AGENT);
        try {
            const response = await this.fetcher(ORIGIN + path, {...init, headers, signal: combined, redirect: "error"});
            if (!response.ok) {
                // 未消费的响应体需要主动取消，否则连接不会释放。
                await response.body?.cancel();
                const authError = response.status === 401 || response.status === 403;
                throw new ServiceError(
                    authError ? "upstream_auth_error" : "upstream_http_error",
                    502,
                    "Upstream HTTP request failed.",
                    // 5xx 与 429 通常是暂时性的，可以重试。
                    response.status >= 500 || response.status === 429,
                    null,
                    undefined,
                    response.status
                );
            }
            return {response, combined};
        } catch (error) {
            throw this.transportError(error, signal, combined);
        }
    }

    // 把 fetch 抛出的异常归一成 ServiceError；调用方主动取消时保留原始原因。
    private transportError(error: unknown, signal: AbortSignal, combined: AbortSignal): unknown {
        if (signal.aborted) return signal.reason;
        if (error instanceof ServiceError) return error;
        if (combined.aborted) return new ServiceError("upstream_timeout", 504, "Upstream request timed out.", true);
        return new ServiceError("upstream_network_error", 502, "Upstream connection failed.", true);
    }

    // 翻译一批文本，返回与 req.texts 等长的译文数组。
    async translate(
        req: UpstreamTranslateRequest,
        signal: AbortSignal,
        provider?: CookieProvider
    ): Promise<UpstreamTranslateResult> {
        const {response, combined} = await this.request("/samantha/plugin/stream_article_translate", signal, {
            method: "POST",
            headers: {"Content-Type": "application/json", Accept: "*/*"},
            body: JSON.stringify(buildRequestBody(req))
        }, this.config.DOUBAO_REQUEST_TIMEOUT_MS, provider ? await provider() : undefined);
        const reader = response.body?.getReader();
        if (!reader) throw new ServiceError("upstream_stream_error", 502, "Upstream response body is missing.", true);
        // 按段下标收集译文；上游可能乱序或重复返回，用 Map 兜底。
        const results = new Map<number, string>();
        const detected = new Set<string>();
        let done = false;
        const parser = new SSEParser((event) => {
            if (event.event === "done") {
                done = true;
                return;
            }
            // 只处理承载数据的三种事件，其余（心跳等）忽略。
            if (event.event !== "json" && event.event !== "err" && event.event !== "message") return;
            const value = parseJSON(event.data);
            checkCode(value);
            if (event.event === "err") throw new ServiceError("upstream_stream_error", 502, "Upstream stream reported an error.");
            const items = (value.data as {items?: unknown} | undefined)?.items;
            if (!Array.isArray(items)) return;
            for (const raw of items) {
                const item = raw as UpstreamItem;
                // 下标越界、类型不对都跳过并告警，不因此整批失败。
                if (!item || typeof item.index !== "number" || !Number.isInteger(item.index) || item.index < 0 || item.index >= req.texts.length) {
                    this.warn("invalid_item_index");
                    continue;
                }
                // 原文非空但译文为空视为异常，避免用空串覆盖有效结果。
                if (typeof item.res !== "string" || (req.texts[item.index]?.trim() ?? "") !== "" && !item.res.trim()) {
                    this.warn("invalid_item_result");
                    continue;
                }
                // 重复下标保留第一次结果。
                if (results.has(item.index)) {
                    this.warn("duplicate_item_index", {index: item.index});
                    continue;
                }
                results.set(item.index, item.res);
                if (typeof item.detect_lang === "string") detected.add(item.detect_lang);
            }
        });
        const type = response.headers.get("content-type")?.toLowerCase() ?? "";
        // 先按 Content-Type 判断；缺失时才靠首字节嗅探。
        let mode: "sse" | "json" | undefined = type.includes("text/event-stream") ? "sse" : type.includes("application/json") ? "json" : undefined;
        let bytes = 0;
        // 嗅探阶段先缓存字节，确定是 JSON 还是 SSE 后再分发。
        let pending: Uint8Array[] = [];
        let pendingLength = 0;
        try {
            for (; ;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > MAX_BODY) throw new ServiceError("upstream_stream_error", 502, "Upstream response exceeds size limit.");
                if (mode === "sse") {
                    parser.push(chunk.value);
                    continue;
                }
                pending.push(chunk.value);
                pendingLength += chunk.value.byteLength;
                if (!mode) {
                    // 嗅探前 64 字节：以 "{" 开头当作 JSON，否则看是否像 SSE 字段。
                    const probe = new TextDecoder().decode(Buffer.concat(pending).subarray(0, 64)).trimStart();
                    if (probe.startsWith("{")) mode = "json";
                    else if (/^(?:event:|data:|id:|retry:|:)/.test(probe)) {
                        mode = "sse";
                        // 已缓存的字节按 SSE 补喂给解析器，避免丢帧。
                        pending.forEach((x) => parser.push(x));
                        pending = [];
                    } else if (pendingLength >= 64)
                        throw new ServiceError("upstream_stream_error", 502, "Unrecognized upstream response.");
                }
            }
            // 非 SSE（即 JSON）说明上游没走流式，本服务无法从中取到分段结果。
            if (mode !== "sse") {
                const value = parseJSON(Buffer.concat(pending).toString("utf8"));
                checkCode(value);
                throw new ServiceError("upstream_incomplete_result", 502, "Upstream returned no translation items.");
            }
            parser.finish();
            // 必须每个下标都有译文，否则视为不完整；全空且没有 done 事件时可重试。
            if (results.size !== req.texts.length)
                throw new ServiceError("upstream_incomplete_result", 502, "Upstream translation is incomplete.", results.size === 0 && !done);
            if (!done) this.warn("missing_done_event");
            // 上面已确认每个下标都有结果，这里的断言只是把 Map 查找结果收窄成 string。
            return {texts: req.texts.map((_, i) => results.get(i) as string), detectedLanguages: [...detected]};
        } catch (error) {
            if (error instanceof ServiceError) throw error;
            throw this.transportError(error, signal, combined);
        } finally {
            // 释放读取器，避免连接泄漏。
            await reader.cancel().catch(() => {
            });
            reader.releaseLock();
        }
    }

    // 校验 Cookie 是否仍然有效，返回结构化状态而不是抛错，
    // 以便上层区分「登录失效」和「暂时无法确认」。
    async authStatus(signal: AbortSignal, provider?: CookieProvider): Promise<AuthStatus> {
        let loaded = false, complete = false;
        try {
            const stored = provider ? await provider() : await loadCookie(this.config.DOUBAO_COOKIE_FILE);
            loaded = true;
            complete = stored.complete;
            if (!complete) return {
                authenticated: false,
                cookie_loaded: true,
                required_login_cookies_present: false,
                reason: "cookie_invalid"
            };
            const {response, combined} = await this.request(
                "/samantha/plugin/user_settings/get?frontend_source=1",
                signal,
                {method: "GET"},
                this.config.DOUBAO_AUTH_TIMEOUT_MS,
                stored
            );
            let value: Record<string, unknown>;
            try {
                const reader = response.body?.getReader();
                if (!reader) throw new ServiceError("upstream_stream_error", 502, "Upstream response body is missing.");
                const chunks: Uint8Array[] = [];
                let length = 0;
                try {
                    for (; ;) {
                        const chunk = await reader.read();
                        if (chunk.done) break;
                        length += chunk.value.length;
                        if (length > MAX_BODY) throw new ServiceError("upstream_stream_error", 502, "Upstream response exceeds size limit.");
                        chunks.push(chunk.value);
                    }
                    value = parseJSON(Buffer.concat(chunks).toString("utf8"));
                } finally {
                    await reader.cancel().catch(() => {
                    });
                    reader.releaseLock();
                }
            } catch (error) {
                throw this.transportError(error, signal, combined);
            }
            return {
                authenticated: value.code === 0,
                cookie_loaded: true,
                required_login_cookies_present: true,
                // 业务码透传给上层，用于区分「Cookie 过期」与「其他登录问题」。
                ...typeof value.code === "number" ? {upstream_code: value.code} : {},
                ...value.code === 0 ? {} : {reason: value.code === 710012001 ? "cookie_expired" : "upstream_auth_error"}
            };
        } catch (error) {
            if (signal.aborted) throw signal.reason;
            // 网络类失败不判定为登录失效，只如实返回错误码，避免误让用户重新登录。
            return {
                authenticated: false,
                cookie_loaded: loaded,
                required_login_cookies_present: complete,
                reason: error instanceof ServiceError ? error.code : "upstream_network_error"
            };
        }
    }
}
