// 配置加载与资源加载单元测试。
// 覆盖 loadConfig（环境变量校验与补全）与 loadProviderIcon（图标内嵌）。
// 运行方式：npm test（或 node --test tests/config.test.ts）
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config/env.js";
import { loadProviderIcon } from "../src/assets.js";
// 配置校验失败时统一抛出 Error，并在消息里列出出错字段路径。
function expectInvalid(env, field) {
    assert.throws(() => loadConfig(env), (error) => error instanceof Error && error.message === `Invalid environment configuration: ${field}`, `应报错字段 ${field}`);
}
// ---------------------------------------------------------------- 默认值
// 空环境变量时所有字段都应有可用默认值。
test("loadConfig 补全默认值", () => {
    const config = loadConfig({});
    assert.equal(config.HOST, "0.0.0.0");
    assert.equal(config.PORT, 8_000);
    assert.equal(config.LOG_LEVEL, "info");
    assert.equal(config.ALLOW_NO_AUTH, false);
    assert.equal(config.ADMIN_ENABLED, true);
    assert.equal(config.ADMIN_COOKIE_SECURE, false);
    assert.equal(config.DOUBAO_DEFAULT_TARGET_LANG, "zh");
    assert.equal(config.DOUBAO_DEFAULT_SCENE, 2);
    assert.equal(config.DOUBAO_MAX_RETRIES, 2);
    assert.equal(config.DOUBAO_MAX_CONCURRENCY, 8);
    assert.equal(config.DOUBAO_QUEUE_MAX, 100);
    assert.equal(config.DOUBAO_REQUEST_TIMEOUT_MS, 45_000);
    assert.equal(config.DOUBAO_TOTAL_TIMEOUT_MS, 180_000);
    assert.equal(config.DOUBAO_AUTH_TIMEOUT_MS, 10_000);
    assert.equal(config.DOUBAO_QUEUE_TIMEOUT_MS, 30_000);
    assert.deepEqual(config.keys, []);
    // 管理数据目录默认与 Cookie 文件同级的 admin 子目录。
    assert.equal(config.DOUBAO_COOKIE_FILE, "/data/cookie.txt");
    assert.equal(config.ADMIN_DATA_DIR, "/data/admin");
});
// 环境变量全是字符串，数值与布尔字段都要强制转换。
test("loadConfig 强制转换环境变量类型", () => {
    const config = loadConfig({
        PORT: "9000",
        DOUBAO_DEFAULT_SCENE: "5",
        DOUBAO_MAX_CONCURRENCY: "3",
        DOUBAO_QUEUE_MAX: "0",
        DOUBAO_MAX_RETRIES: "0",
        ALLOW_NO_AUTH: "true",
        ADMIN_ENABLED: "false",
        ADMIN_COOKIE_SECURE: "true",
    });
    assert.equal(config.PORT, 9_000);
    assert.equal(typeof config.PORT, "number");
    assert.equal(config.DOUBAO_DEFAULT_SCENE, 5);
    assert.equal(config.DOUBAO_MAX_CONCURRENCY, 3);
    assert.equal(config.DOUBAO_QUEUE_MAX, 0);
    assert.equal(config.DOUBAO_MAX_RETRIES, 0);
    assert.equal(config.ALLOW_NO_AUTH, true);
    assert.equal(config.ADMIN_ENABLED, false);
    assert.equal(config.ADMIN_COOKIE_SECURE, true);
    // 字符串选项原样保留。
    assert.equal(loadConfig({ HOST: "127.0.0.1", DOUBAO_USER_AGENT: "ua" }).DOUBAO_USER_AGENT, "ua");
});
// 默认语言同样要归一化，非法语言直接报错、空白回退默认值。
test("loadConfig 归一化默认目标语言", () => {
    assert.equal(loadConfig({ DOUBAO_DEFAULT_TARGET_LANG: "zh-TW" }).DOUBAO_DEFAULT_TARGET_LANG, "zh-Hant");
    assert.equal(loadConfig({ DOUBAO_DEFAULT_TARGET_LANG: "en-US" }).DOUBAO_DEFAULT_TARGET_LANG, "en");
    assert.equal(loadConfig({ DOUBAO_DEFAULT_TARGET_LANG: "   " }).DOUBAO_DEFAULT_TARGET_LANG, "zh");
    expectInvalid({ DOUBAO_DEFAULT_TARGET_LANG: "klingon" }, "DOUBAO_DEFAULT_TARGET_LANG");
});
// 管理数据目录默认派生自 Cookie 文件所在目录，显式配置时优先。
test("loadConfig 派生管理数据目录", () => {
    assert.equal(loadConfig({ DOUBAO_COOKIE_FILE: "/srv/data/cookie.txt" }).ADMIN_DATA_DIR, "/srv/data/admin");
    assert.equal(loadConfig({ DOUBAO_COOKIE_FILE: "/srv/data/cookie.txt", ADMIN_DATA_DIR: "/x" }).ADMIN_DATA_DIR, "/x");
});
// 未声明的环境变量被忽略，不会进入配置对象。
test("loadConfig 忽略未知字段", () => {
    const config = loadConfig({ TOTALLY_UNKNOWN: "1", PATH: "/usr/bin" });
    assert.equal("TOTALLY_UNKNOWN" in config, false);
    assert.equal("PATH" in config, false);
});
// ---------------------------------------------------------------- API key 解析
// API_KEYS 支持逗号分隔多个 key，并过滤空项与首尾空格。
test("loadConfig 解析逗号分隔的 API_KEYS", () => {
    assert.deepEqual(loadConfig({ API_KEYS: " a , b ,, c " }).keys, ["a", "b", "c"]);
    assert.deepEqual(loadConfig({ API_KEYS: "single" }).keys, ["single"]);
    // 单数 API_KEY 同样支持。
    assert.deepEqual(loadConfig({ API_KEY: "x" }).keys, ["x"]);
    // 同时提供时 API_KEYS 优先。
    assert.deepEqual(loadConfig({ API_KEY: "x", API_KEYS: "y" }).keys, ["y"]);
});
// 显式配置了 API_KEYS 却解析不出任何 key，属于配置错误。
test("loadConfig 拒绝空的 API_KEYS", () => {
    assert.throws(() => loadConfig({ API_KEYS: " , " }), /API_KEYS must contain at least one key\./);
    // 允许匿名访问时不再强制要求 key。
    assert.deepEqual(loadConfig({ API_KEYS: " , ", ALLOW_NO_AUTH: "true" }).keys, []);
});
// ---------------------------------------------------------------- 非法配置
// 数值范围越界统一报错，并在消息里指出字段。
test("loadConfig 拒绝越界数值", () => {
    expectInvalid({ PORT: "70000" }, "PORT");
    expectInvalid({ PORT: "0" }, "PORT");
    expectInvalid({ PORT: "-1" }, "PORT");
    expectInvalid({ PORT: "abc" }, "PORT");
    expectInvalid({ DOUBAO_DEFAULT_SCENE: "7" }, "DOUBAO_DEFAULT_SCENE");
    expectInvalid({ DOUBAO_DEFAULT_SCENE: "0" }, "DOUBAO_DEFAULT_SCENE");
    expectInvalid({ DOUBAO_MAX_RETRIES: "11" }, "DOUBAO_MAX_RETRIES");
    expectInvalid({ DOUBAO_MAX_RETRIES: "-1" }, "DOUBAO_MAX_RETRIES");
    expectInvalid({ DOUBAO_QUEUE_MAX: "-1" }, "DOUBAO_QUEUE_MAX");
});
// 枚举与 URL 类字段只接受规定取值。
test("loadConfig 校验枚举与 URL 字段", () => {
    expectInvalid({ LOG_LEVEL: "verbose" }, "LOG_LEVEL");
    expectInvalid({ ADMIN_ORIGIN: "not-a-url" }, "ADMIN_ORIGIN");
    // 合法取值可以正常通过。
    assert.equal(loadConfig({ LOG_LEVEL: "debug" }).LOG_LEVEL, "debug");
    assert.equal(loadConfig({ ADMIN_ORIGIN: "https://example.com" }).ADMIN_ORIGIN, "https://example.com");
});
// 管理密码有长度下限，避免使用弱口令。
test("loadConfig 校验管理密码长度", () => {
    expectInvalid({ ADMIN_PASSWORD: "short" }, "ADMIN_PASSWORD");
    // 不少于 12 位的密码可以通过。
    assert.equal(loadConfig({ ADMIN_PASSWORD: "a-strong-password" }).ADMIN_PASSWORD, "a-strong-password");
});
// 多个字段同时非法时逐个列出。
test("loadConfig 汇总多个非法字段", () => {
    assert.throws(() => loadConfig({ PORT: "0", LOG_LEVEL: "verbose" }), /Invalid environment configuration: PORT, LOG_LEVEL/);
});
// ---------------------------------------------------------------- loadProviderIcon
// 图标以 data URL 形式内嵌返回，无需额外网络请求。
test("loadProviderIcon 返回内嵌的 PNG data URL", async () => {
    const icon = await loadProviderIcon();
    assert.match(icon, /^data:image\/png;base64,/);
    const base64 = icon.slice("data:image/png;base64,".length);
    const png = Buffer.from(base64, "base64");
    // PNG 魔数校验，确认解出来的是真实图片且非空。
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(png.byteLength > 0);
    // 重复调用结果稳定。
    assert.equal(await loadProviderIcon(), icon);
});
