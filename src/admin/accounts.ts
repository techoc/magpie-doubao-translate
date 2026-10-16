// Cookie 导入与账号失败判定。
//
// 支持两种登录输入：直接粘贴的 Cookie 请求头，以及浏览器导出的 Cookie JSON。
// 导入时做严格白名单校验，避免把非法内容写进请求头。
// importCookie     插件登录流程与每次请求取 Cookie 都会调用
// isAccountFailure 供翻译编排判断是否需要切换账号

import { external_exports as z } from "../vendor/zod.js";
import { ServiceError, invalid } from "../core/errors.ts";
import { parseCookie } from "../auth/cookie-store.ts";
import type { StoredCookie } from "../types.ts";

// 以下 schema 描述 API 服务版账号池的持久化格式。
const healthSchema = z.object({
    status: z.enum(["unknown", "valid", "invalid", "cooldown"]).default("unknown"),
    reason: z.string().optional(),
    checkedAt: z.number().optional(),
    cooldownUntil: z.number().default(0)
});
const accountSchema = z.object({
    id: z.string(),
    name: z.string().min(1).max(64),
    enabled: z.boolean(),
    cookie: z.string().optional(),
    revision: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    lastUsedAt: z.number().optional(),
    fingerprint: z.string().optional(),
    health: healthSchema
});
// 账号池状态的持久化格式。插件版不用账号池，但保留 schema 作为格式说明，
// 也被单元测试用来校验字段约束。
export const stateSchema = z.object({
    version: z.literal(1),
    mode: z.enum(["failover", "round-robin", "manual"]),
    activeId: z.string(),
    accounts: z.array(accountSchema).min(1).max(101)
});

// 把外部输入（Cookie 头或导出的 JSON）归一成 { cookie, complete }。
// 校验不通过时统一抛 invalid，避免把上游解析细节暴露给客户端。
export function importCookie(input: string): StoredCookie {
    let text = input.trim();
    // 以 [ 或 { 开头视为导出的 Cookie JSON。
    if (text.startsWith("[") || text.startsWith("{")) {
        let value: unknown;
        try {
            value = JSON.parse(text);
        } catch {
            throw invalid("Cookie JSON is invalid.");
        }
        // 兼容两种导出结构：顶层数组，或 { cookies: [...] }。
        const list = Array.isArray(value)
            ? value
            : value && typeof value === "object" && "cookies" in value
                ? (value as {cookies?: unknown}).cookies
                : undefined;
        if (!Array.isArray(list)) throw invalid("Expected an exported cookie array.");
        // 只保留豆包域下的 Cookie；domain 缺失时按兼容处理保留。
        text = list.filter((item: unknown) => {
            const entry = item as {domain?: unknown} | null;
            return entry && (entry.domain === undefined || typeof entry.domain === "string" && /^(?:\.)?(?:www\.)?doubao\.com$/i.test(entry.domain));
        }).map((item: unknown) => {
            const entry = item as {name?: unknown; value?: unknown};
            // 名称走 RFC 6265 token 白名单，值禁止分号与换行，防止请求头注入。
            if (typeof entry.name !== "string" || !/^[A-Za-z0-9_!#$%&'*+.^`|~-]+$/.test(entry.name) || typeof entry.value !== "string" || /[;\r\n]/.test(entry.value)) throw invalid("Invalid exported cookie entry.");
            return `${entry.name}=${entry.value}`;
        }).join("; ");
    }
    try {
        const result = parseCookie(text);
        // 单独说明缺失项，比笼统的「Cookie 无效」更有指导性。
        if (!result.complete) throw invalid("Cookie must contain sessionid, sid_tt and uid_tt.");
        return result;
    } catch (error) {
        // 上面的 400 错误原样抛出，其余（如非法字符）重新包装成统一文案。
        if (error instanceof ServiceError && error.status === 400) throw error;
        throw invalid("Cookie contains unsafe characters or is empty.");
    }
}

// 判断某个错误是否应归因到「这个账号不行」，从而触发故障切换。
// Cookie 类错误与网络/超时类错误都算；HTTP 5xx 等只有在标记可重试时才算，
// 避免把上游整体故障误判成单个账号的问题。
export function isAccountFailure(error: unknown): boolean {
    return error instanceof ServiceError && ([
        "cookie_missing",
        "cookie_invalid",
        "upstream_auth_error",
        "upstream_timeout",
        "upstream_network_error"
    ].includes(error.code) || ["upstream_http_error", "upstream_incomplete_result"].includes(error.code) && error.retryable);
}
