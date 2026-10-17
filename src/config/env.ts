// 配置 schema。
//
// 这套字段最初服务于独立 API 服务版，插件版通过 loadConfig() 用自身选项拼出
// 同样的结构，从而复用同一套翻译核心，而不是各自读环境变量。

import { dirname, join } from "node:path";
import { z } from "zod";
import { normalizeLanguage } from "../doubao/languages.ts";

// 正整数，带默认值。环境变量一律是字符串，所以先 coerce。
const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);
// 环境变量里的布尔值写作字符串 "true" / "false"。
const boolEnv = z.enum(["true", "false"]).default("false").transform((x) => x === "true");
// 默认目标语言：空串按未设置处理，交给默认值；非法语言名直接报错。
const defaultLanguageSchema = z.preprocess(
    (value) => typeof value === "string" && !value.trim() ? undefined : value,
    z.string().refine((value) => {
        try {
            normalizeLanguage(value);
            return true;
        } catch {
            return false;
        }
    }, "Unsupported default target language.").transform((value) => normalizeLanguage(value)).default("zh")
);
// 带 DOUBAO_ 前缀的字段是翻译核心需要读取的配置。
const envSchema = z.object({
    HOST: z.string().default("0.0.0.0"),
    PORT: positiveInt(8_000).pipe(z.number().max(65535)),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    API_KEY: z.string().optional(),
    API_KEYS: z.string().optional(),
    ALLOW_NO_AUTH: boolEnv,
    DOUBAO_COOKIE_FILE: z.string().default("/data/cookie.txt"),
    DOUBAO_DEFAULT_SCENE: positiveInt(2).pipe(z.number().max(6)),
    DOUBAO_DEFAULT_TARGET_LANG: defaultLanguageSchema,
    DOUBAO_REQUEST_TIMEOUT_MS: positiveInt(45_000),
    DOUBAO_TOTAL_TIMEOUT_MS: positiveInt(180_000),
    DOUBAO_AUTH_TIMEOUT_MS: positiveInt(10_000),
    DOUBAO_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
    DOUBAO_MAX_CONCURRENCY: positiveInt(8),
    DOUBAO_QUEUE_MAX: z.coerce.number().int().min(0).default(100),
    DOUBAO_QUEUE_TIMEOUT_MS: positiveInt(30_000),
    DOUBAO_USER_AGENT: z.string().optional(),
    CORS_ORIGINS: z.string().optional(),
    ADMIN_ENABLED: z.enum(["true", "false"]).default("true").transform((x) => x === "true"),
    ADMIN_DATA_DIR: z.string().optional(),
    ADMIN_PASSWORD: z.string().min(12).max(256).optional(),
    ADMIN_COOKIE_SECURE: boolEnv,
    ADMIN_ORIGIN: z.url().optional(),
    TRUST_PROXY: z.string().optional()
});

// 校验并补全后的配置对象：schema 字段 + 解析出的 keys + 派生出的 ADMIN_DATA_DIR。
export type EnvConfig = z.infer<typeof envSchema> & {
    // 解析后的 API key 列表（API_KEYS 优先，其次 API_KEY，逗号分隔）。
    keys: string[];
    // 管理页数据目录：显式配置优先，否则取 Cookie 文件同级的 admin 子目录。
    ADMIN_DATA_DIR: string;
};

// 校验并补全配置。任一项非法都会抛出，错误信息列出出错字段路径。
export function loadConfig(env: Record<string, string | undefined> = process.env): EnvConfig {
    const parsed = envSchema.safeParse(env);
    if (!parsed.success) throw new Error("Invalid environment configuration: " + parsed.error.issues.map((issue) => issue.path.join(".")).join(", "));
    const config = parsed.data;
    // API_KEYS 优先，其次 API_KEY，两者都支持逗号分隔的多个 key。
    const keys = (config.API_KEYS !== undefined ? config.API_KEYS : config.API_KEY ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    // 显式要求鉴权却配不出任何 key，属于配置错误而非运行时错误。
    if (!config.ALLOW_NO_AUTH && config.API_KEYS !== undefined && !keys.length)
        throw new Error("API_KEYS must contain at least one key.");
    // DEFAULT_TARGET_LANG 在 schema 里已归一化为规范语言代码。
    return {
        ...config,
        keys,
        // 管理页数据默认与 Cookie 文件同目录，便于整体迁移。
        ADMIN_DATA_DIR: config.ADMIN_DATA_DIR ?? join(dirname(config.DOUBAO_COOKIE_FILE), "admin")
    };
}
