// Cookie 解析、导入与账号失败判定单元测试。
// 运行方式：npm test（或 node --test tests/cookie.test.ts）

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadCookie, parseCookie } from "../src/auth/cookie-store.ts";
import { importCookie, isAccountFailure } from "../src/admin/accounts.ts";
import { ServiceError } from "../src/core/errors.ts";
import { failedWith, serviceError } from "./helpers.ts";

// 三个必需登录 Cookie 齐全的请求头，测试里反复用到。
const FULL = "sessionid=a; sid_tt=b; uid_tt=c";
// 校验错误码与状态，避免只断言 message 造成测试脆弱。
const withCode = (code: string, status: number) => failedWith(code, status);
// 断言 400 且 message 匹配给定正则。
const status400 = (pattern: RegExp) => (error: unknown): boolean => {
    const value = serviceError(error);
    return value.status === 400 && pattern.test(value.message);
};

// ---------------------------------------------------------------- parseCookie

// 三个必需 Cookie 齐全时 complete 为 true，并原样保留请求头内容。
test("parseCookie 识别完整的登录 Cookie", () => {
    assert.deepEqual(parseCookie(FULL), {cookie: FULL, complete: true});
    // 允许带 "Cookie: " 前缀，方便直接粘贴浏览器复制的内容。
    assert.deepEqual(parseCookie(`Cookie: ${FULL}`), {cookie: FULL, complete: true});
    // 多余的 Cookie 不影响判定。
    assert.equal(parseCookie(`${FULL}; other=1`).complete, true);
});

// 缺项时只标记 complete=false，不抛错（由调用方决定如何提示）。
test("parseCookie 对缺项只标记不完整", () => {
    for (const value of ["sessionid=a", "sessionid=a; sid_tt=b", "sid_tt=b; uid_tt=c", "uid_tt=c"]) {
        const result = parseCookie(value);
        assert.equal(result.complete, false, `${value} 不应判定为完整`);
    }
    // 值为空的 Cookie 不算「存在」。
    assert.equal(parseCookie("sessionid=; sid_tt=b; uid_tt=c").complete, false);
});

// 空内容、非 ASCII 字符、超长内容都不能安全放进请求头。
test("parseCookie 拒绝不安全内容", () => {
    for (const value of ["", "   ", "sessionid=ä", "sessionid=a\nb", "a".repeat(32_769)]) {
        assert.throws(() => parseCookie(value), withCode("cookie_invalid", 502), `应拒绝：${JSON.stringify(value.slice(0, 20))}`);
    }
});

// ---------------------------------------------------------------- loadCookie

// 文件不存在与读不了要给出不同的错误码，便于提示用户先配置。
test("loadCookie 区分文件缺失与不可读", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cookie-store-"));
    try {
        await assert.rejects(() => loadCookie(join(dir, "missing.txt")), withCode("cookie_missing", 502));
        // 目录路径不是合法 Cookie 文件，读取会失败但不是 ENOENT。
        await assert.rejects(() => loadCookie(dir), withCode("cookie_invalid", 502));

        const path = join(dir, "cookie.txt");
        await writeFile(path, `${FULL}\n`, "utf8");
        assert.deepEqual(await loadCookie(path), {cookie: FULL, complete: true});
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

// ---------------------------------------------------------------- importCookie

// 直接粘贴的 Cookie 头必须包含三个必需项。
test("importCookie 校验 Cookie 头的必需项", () => {
    assert.deepEqual(importCookie(FULL), {cookie: FULL, complete: true});
    assert.throws(() => importCookie("sessionid=a"), status400(/sessionid, sid_tt and uid_tt/));
    // 非法字符被重新包装成统一文案，避免暴露内部细节。
    assert.throws(() => importCookie("sessionid=ä"), status400(/unsafe characters or is empty/));
});

// 浏览器导出的 Cookie JSON 支持顶层数组与 { cookies: [...] } 两种结构。
test("importCookie 接受两种导出 JSON 结构", () => {
    const entry = (name: string, value: string, domain?: string) => domain ? {domain, name, value} : {name, value};
    const list = [entry("sessionid", "a", "doubao.com"), entry("sid_tt", "b", ".doubao.com"), entry("uid_tt", "c", "www.doubao.com")];
    assert.equal(importCookie(JSON.stringify(list)).cookie, FULL);
    assert.equal(importCookie(JSON.stringify({cookies: list})).cookie, FULL);
    // domain 缺失时按兼容处理保留。
    assert.equal(importCookie(JSON.stringify([entry("sessionid", "a"), entry("sid_tt", "b"), entry("uid_tt", "c")])).cookie, FULL);
});

// JSON 结构非法时给出明确的 400 错误文案。
test("importCookie 拒绝非法导出结构", () => {
    assert.throws(() => importCookie("[{"), status400(/^Cookie JSON is invalid\.$/));
    assert.throws(() => importCookie('{"a":1}'), status400(/^Expected an exported cookie array\.$/));
});

// Cookie 名称走 RFC 6265 白名单，值禁止分号与换行，防止请求头注入。
test("importCookie 拒绝非法条目", () => {
    const bad = [
        [{name: "a;b", value: "x"}],
        [{name: "sessionid", value: "x\ny"}],
        [{name: "sessionid", value: "x;y"}],
        [{name: 1, value: "x"}],
        [{name: "sessionid", value: 1}],
    ];
    for (const list of bad)
        assert.throws(() => importCookie(JSON.stringify(list)), status400(/^Invalid exported cookie entry\.$/));
    // 非对象条目在域名过滤阶段就被剔除，最终按空内容处理。
    assert.throws(() => importCookie(JSON.stringify([null])), status400(/unsafe characters or is empty/));
});

// 非豆包域的 Cookie 被过滤掉；若过滤后凑不齐必需项，则按不安全/为空处理。
test("importCookie 过滤非豆包域 Cookie", () => {
    const list = [{domain: "example.com", name: "sessionid", value: "a"}];
    assert.throws(() => importCookie(JSON.stringify(list)), status400(/unsafe characters or is empty/));
    // 过滤后补齐三项时仍可导入。
    const mixed = [...list, {domain: "www.doubao.com", name: "sessionid", value: "a"}, {name: "sid_tt", value: "b"}, {name: "uid_tt", value: "c"}];
    assert.equal(importCookie(JSON.stringify(mixed)).cookie, FULL);
});

// ---------------------------------------------------------------- isAccountFailure

// Cookie 类与网络类错误恒为账号级失败，应触发故障切换。
test("isAccountFailure 对登录与网络类错误恒为真", () => {
    for (const code of ["cookie_missing", "cookie_invalid", "upstream_auth_error", "upstream_timeout", "upstream_network_error"]) {
        assert.equal(isAccountFailure(new ServiceError(code, 502, "x")), true, `${code} 应判定为账号失败`);
        // 即使错误不可重试（如登录失效）也仍然算账号问题。
        assert.equal(isAccountFailure(new ServiceError(code, 502, "x", false)), true);
    }
});

// 上游 5xx / 结果不完整只有在标记可重试时才归因到账号。
test("isAccountFailure 对上游错误依赖 retryable", () => {
    for (const code of ["upstream_http_error", "upstream_incomplete_result"]) {
        assert.equal(isAccountFailure(new ServiceError(code, 502, "x", true)), true);
        assert.equal(isAccountFailure(new ServiceError(code, 502, "x", false)), false);
    }
});

// 请求参数类错误与普通异常不属于账号失败。
test("isAccountFailure 对非账号错误为假", () => {
    for (const code of ["model_not_found", "invalid_request", "unsupported_feature", "internal_error"]) {
        assert.equal(isAccountFailure(new ServiceError(code, 400, "x")), false, `${code} 不应判定为账号失败`);
    }
    assert.equal(isAccountFailure(new Error("boom")), false);
    assert.equal(isAccountFailure(undefined), false);
});
