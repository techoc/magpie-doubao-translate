// 豆包上游客户端单元测试：SSE 解析与 stream_article_translate 响应处理。
// 运行方式：npm test（或 node --test tests/doubao.test.ts）

import assert from "node:assert/strict";
import { test } from "node:test";

import { SSEParser } from "../src/doubao/sse-parser.ts";
import { DoubaoClient } from "../src/doubao/client.ts";
import { loadConfig } from "../src/config/env.ts";
import { ServiceError } from "../src/core/errors.ts";
import type { AuthStatus, StoredCookie, UpstreamTranslateRequest, UpstreamTranslateResult } from "../src/types.ts";
import { failedWith, serviceError } from "./helpers.ts";

// SSEParser 派发的事件形状。
type SseEvent = {event: string; data: string};
// 警告记录：warn(name, detail)。
type Warning = [name: string, detail?: unknown];
// 调用结果：成功时只有 result，失败时只有 error，两个字段都可选便于统一断言。
type Outcome = {result?: UpstreamTranslateResult; error?: unknown};

// ---------------------------------------------------------------- SSEParser

// 把字节块喂给解析器并收集事件，方便按 chunk 粒度验证。
function collect(chunks: string[], {finish = true}: {finish?: boolean} = {}): SseEvent[] {
    const events: SseEvent[] = [];
    const parser = new SSEParser((event) => events.push(event));
    for (const chunk of chunks) parser.push(new TextEncoder().encode(chunk));
    if (finish) parser.finish();
    return events;
}

// 基本字段解析：event + 单行 data，空行触发派发。
test("SSEParser 解析 event 与 data 字段", () => {
    assert.deepEqual(collect(["event: json\ndata: {\"a\":1}\n\n"]), [{event: "json", data: '{"a":1}'}]);
    // 规范要求冒号后最多去掉一个前导空格，多余空格属于数据。
    assert.deepEqual(collect(["data:  x\n\n"]), [{event: "message", data: " x"}]);
    // 没有 event 字段时默认 message。
    assert.deepEqual(collect(["data: y\n\n"]), [{event: "message", data: "y"}]);
    // 没有冒号的行按空值处理。
    assert.deepEqual(collect(["data\n\n"]), [{event: "message", data: ""}]);
});

// 多行 data 按换行拼接，注释行（心跳）忽略。
test("SSEParser 拼接多行 data 并忽略注释", () => {
    assert.deepEqual(collect(["data: a\ndata: b\n\n"]), [{event: "message", data: "a\nb"}]);
    assert.deepEqual(collect([": keepalive\n\n"]), []);
    assert.deepEqual(collect([": ping\ndata: v\n\n"]), [{event: "message", data: "v"}]);
});

// EOF 时最后一行可能没有换行符，仍需派发。
test("SSEParser 在 EOF 冲刷未结束的行与事件", () => {
    assert.deepEqual(collect(["data: tail"]), [{event: "message", data: "tail"}]);
    assert.deepEqual(collect(["event: json\ndata: {}\n\n", "data: last"]), [
        {event: "json", data: "{}"},
        {event: "message", data: "last"},
    ]);
    // 已派发完的事件在 finish 时不会重复触发。
    assert.deepEqual(collect(["data: a\n\n"]), [{event: "message", data: "a"}]);
});

// 换行可能被拆到两个 chunk 里：CRLF 要合并，不能多产生一个空事件。
test("SSEParser 跨 chunk 合并 CRLF 与多字节字符", () => {
    assert.deepEqual(collect(["data: a\r", "\n\r", "\n"]), [{event: "message", data: "a"}]);
    // 单独的 \r 换行同样被识别。
    assert.deepEqual(collect(["data: a\r\r"]), [{event: "message", data: "a"}]);
    // UTF-8 字符被拆到两个 chunk 时用流式解码拼回。
    const bytes = new TextEncoder().encode("data: 你好\n\n");
    const events: SseEvent[] = [];
    const parser = new SSEParser((event) => events.push(event));
    parser.push(bytes.subarray(0, 8));
    parser.push(bytes.subarray(8));
    parser.finish();
    assert.deepEqual(events, [{event: "message", data: "你好"}]);
});

// 每个事件结束后 event 与 data 都要重置。
test("SSEParser 事件之间重置状态", () => {
    assert.deepEqual(collect(["event: json\ndata: 1\n\ndata: 2\n\n"]), [
        {event: "json", data: "1"},
        {event: "message", data: "2"},
    ]);
});

// ---------------------------------------------------------------- DoubaoClient 测试脚手架

// 使用不存在的 Cookie 文件路径，强制测试通过 provider 注入 Cookie。
const config = loadConfig({DOUBAO_COOKIE_FILE: "/tmp/doubao-client-test-missing.txt", DOUBAO_USER_AGENT: "test-agent"});
const COOKIE: StoredCookie = {cookie: "sessionid=a; sid_tt=b; uid_tt=c", complete: true};
const provider = async (): Promise<StoredCookie> => COOKIE;
const REQ: UpstreamTranslateRequest = {texts: ["Hello"], targetLang: "zh", scene: 2, engine: "1"};

// 构造豆包风格的 SSE 响应。
function sseResponse(
    items: unknown[],
    {code = 0, event = "json", done = true, headers = {"content-type": "text/event-stream"}}: {
        code?: number;
        event?: string;
        done?: boolean;
        headers?: Record<string, string>;
    } = {}
): Response {
    const frames = [
        `event: ${event}\ndata: ${JSON.stringify({code, data: {items}})}\n\n`,
        done ? "event: done\ndata: {}\n\n" : "",
    ];
    return new Response(frames.join(""), {headers});
}

// 用可注入的 fetcher 调用 translate，返回译文或归一化后的错误信息。
async function translate(
    fetcher: typeof fetch,
    req: UpstreamTranslateRequest = REQ,
    warnings: Warning[] = []
): Promise<Outcome> {
    const client = new DoubaoClient(config, fetcher, (...args) => warnings.push(args));
    try {
        return {result: await client.translate(req, new AbortController().signal, provider)};
    } catch (error) {
        return {error};
    }
}

// 断言失败结果的错误码与是否可重试。
const expectError = (outcome: Outcome, code: string, retryable: boolean): ServiceError => {
    const error = serviceError(outcome.error);
    assert.equal(error.code, code);
    assert.equal(error.status, code === "upstream_timeout" ? 504 : 502);
    assert.equal(error.retryable, retryable);
    return error;
};

// 断言成功结果存在，返回结果对象。
const expectResult = (outcome: Outcome): UpstreamTranslateResult => {
    assert.ok(outcome.result, `期望成功返回，实际：${JSON.stringify(outcome)}`);
    return outcome.result;
};

// ---------------------------------------------------------------- 请求构造

// 请求体、请求头与安全选项都要符合豆包网页接口的预期。
test("translate 构造上游请求", async () => {
    // 记录实际发出的请求。headers 已被客户端构造为 Headers 实例。
    let captured: {url: string; init: RequestInit; headers: Headers} | undefined;
    const client = new DoubaoClient(config, async (url, init) => {
        captured = {url: String(url), init: init ?? {}, headers: new Headers(init?.headers)};
        return sseResponse([{index: 0, res: "你好"}]);
    }, () => {});
    await client.translate({texts: ["Hello"], targetLang: "ko", scene: 3, engine: "3"}, new AbortController().signal, provider);

    if (!captured) throw new Error("应当捕获到上游请求");
    assert.equal(captured.url, "https://www.doubao.com/samantha/plugin/stream_article_translate");
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.redirect, "error");
    assert.equal(captured.headers.get("Cookie"), COOKIE.cookie);
    assert.equal(captured.headers.get("User-Agent"), "test-agent");
    assert.deepEqual(JSON.parse(String(captured.init.body)), {
        raw_text: ["Hello"],
        target_lang: "ko",
        translate_service: "3",
        scene: 3,
        frontend_source: 1,
    });
});

// Cookie 不完整时无法发起请求。
test("translate 拒绝不完整的 Cookie", async () => {
    const client = new DoubaoClient(config, async () => sseResponse([{index: 0, res: "x"}]), () => {});
    await assert.rejects(
        () => client.translate(REQ, new AbortController().signal, async () => ({cookie: "sessionid=a", complete: false})),
        failedWith("cookie_invalid", 502),
    );
});

// 响应没有可读 body 时按可重试的流错误处理。
test("translate 拒绝缺失的响应体", async () => {
    const outcome = await translate(async () => new Response(null, {status: 200}));
    expectError(outcome, "upstream_stream_error", true);
});

// ---------------------------------------------------------------- 正常结果

// 正常返回与请求等长的译文数组，并汇总检测到的语言。
test("translate 返回译文与检测语言", async () => {
    const outcome = await translate(async () => sseResponse([
        {index: 0, res: "你好", detect_lang: "en"},
        {index: 1, res: "世界", detect_lang: "fr"},
    ]), {...REQ, texts: ["Hello", "World"]});
    assert.deepEqual(expectResult(outcome), {texts: ["你好", "世界"], detectedLanguages: ["en", "fr"]});
});

// 上游乱序返回时按 index 回填；重复 index 保留第一次结果并告警。
test("translate 按下标回填并忽略重复项", async () => {
    const ordered = await translate(async () => sseResponse([{index: 1, res: "B"}, {index: 0, res: "A"}]), {...REQ, texts: ["a", "b"]});
    assert.deepEqual(expectResult(ordered).texts, ["A", "B"]);

    const warnings: Warning[] = [];
    const duplicated = await translate(async () => sseResponse([{index: 0, res: "first"}, {index: 0, res: "second"}]), REQ, warnings);
    assert.deepEqual(expectResult(duplicated).texts, ["first"]);
    assert.ok(warnings.some(([name]) => name === "duplicate_item_index"));
});

// 越界下标与非字符串译文被跳过并告警，不影响同批其他段落。
test("translate 跳过非法条目并告警", async () => {
    const warnings: Warning[] = [];
    const outcome = await translate(async () => sseResponse([
        {index: 9, res: "越界"},
        {index: -1, res: "负数"},
        {index: 0.5, res: "非整数"},
        {index: 0, res: 42},
        {index: 0, res: "valid"},
    ]), REQ, warnings);
    assert.deepEqual(expectResult(outcome).texts, ["valid"]);
    assert.ok(warnings.some(([name]) => name === "invalid_item_index"));
    assert.ok(warnings.some(([name]) => name === "invalid_item_result"));
});

// 原文非空但译文为空视为异常，避免用空串覆盖有效结果。
test("translate 拒绝空译文条目", async () => {
    const outcome = await translate(async () => sseResponse([{index: 0, res: "   "}]));
    expectError(outcome, "upstream_incomplete_result", false);
});

// 缺少段落的响应属于不完整结果（有内容时不可重试）。
test("translate 要求每段都有译文", async () => {
    const outcome = await translate(async () => sseResponse([{index: 0, res: "A"}]), {...REQ, texts: ["a", "b"]});
    expectError(outcome, "upstream_incomplete_result", false);
    // 完全没有译文且没有 done 事件时判定为可重试。
    const empty = await translate(async () => sseResponse([], {done: false}));
    expectError(empty, "upstream_incomplete_result", true);
    // 有 done 但没有译文则不可重试。
    expectError(await translate(async () => sseResponse([])), "upstream_incomplete_result", false);
});

// 缺少 done 事件只告警，不影响结果。
test("translate 对缺失 done 事件告警但成功返回", async () => {
    const warnings: Warning[] = [];
    const outcome = await translate(async () => sseResponse([{index: 0, res: "你好"}], {done: false}), REQ, warnings);
    assert.deepEqual(expectResult(outcome).texts, ["你好"]);
    assert.ok(warnings.some(([name]) => name === "missing_done_event"));
});

// ---------------------------------------------------------------- 上游业务码

// 登录失效码映射为不可重试的 upstream_auth_error。
test("translate 映射登录失效业务码", async () => {
    const error = expectError(await translate(async () => sseResponse([], {code: 710012001})), "upstream_auth_error", false);
    assert.equal(error.upstreamCode, 710012001);
    assert.equal(error.message, "Upstream login has expired.");
});

// 已知业务码全部不可重试（重试也没用）。
test("translate 已知业务码不可重试", async () => {
    const cases: [number, string][] = [[710010202, "upstream_bad_request"], [710020202, "upstream_bad_request"], [710020702, "upstream_stream_error"]];
    for (const [code, expected] of cases) {
        const error = expectError(await translate(async () => sseResponse([], {code})), expected, false);
        assert.equal(error.upstreamCode, code);
    }
});

// 未列出的业务码按可重试的流错误处理。
test("translate 未知业务码可重试", async () => {
    const error = expectError(await translate(async () => sseResponse([], {code: 123456})), "upstream_stream_error", true);
    assert.equal(error.upstreamCode, 123456);
});

// err 事件表示上游流内报错。
test("translate 处理 err 事件", async () => {
    const outcome = await translate(async () => new Response("event: err\ndata: {\"code\":0}\n\nevent: done\ndata: {}\n\n", {
        headers: {"content-type": "text/event-stream"}
    }));
    expectError(outcome, "upstream_stream_error", false);
});

// 数据帧不是合法 JSON（例如 HTML 错误页）时按流错误处理。
test("translate 拒绝无法解析的数据帧", async () => {
    const outcome = await translate(async () => new Response("event: json\ndata: <html>\n\nevent: done\ndata: {}\n\n", {
        headers: {"content-type": "text/event-stream"}
    }));
    expectError(outcome, "upstream_stream_error", false);
});

// ---------------------------------------------------------------- HTTP 与传输

// 401 / 403 视为登录失效；5xx 与 429 可重试；其余 4xx 不可重试。
test("translate 归一化 HTTP 错误", async () => {
    for (const status of [401, 403]) {
        const error = expectError(await translate(async () => new Response("no", {status})), "upstream_auth_error", false);
        assert.equal(error.upstreamStatus, status);
    }
    for (const status of [500, 502, 429]) {
        const error = expectError(await translate(async () => new Response("no", {status})), "upstream_http_error", true);
        assert.equal(error.upstreamStatus, status);
    }
    const bad = expectError(await translate(async () => new Response("no", {status: 400})), "upstream_http_error", false);
    assert.equal(bad.upstreamStatus, 400);
});

// fetch 抛异常按网络错误处理（可重试）。
test("translate 归一化网络异常", async () => {
    expectError(await translate(async () => {
        throw new TypeError("fetch failed");
    }), "upstream_network_error", true);
});

// 调用方中断时抛出中断原因本身，不包装成 ServiceError。
test("translate 传播调用方中断原因", async () => {
    const controller = new AbortController();
    const reason = new Error("client cancelled");
    const client = new DoubaoClient(config, async () => {
        controller.abort(reason);
        throw new Error("boom");
    }, () => {});
    await assert.rejects(
        () => client.translate(REQ, controller.signal, provider),
        (error) => error === reason,
    );
});

// ---------------------------------------------------------------- Content-Type 与嗅探

// Content-Type 缺失时靠首字节嗅探：SSE 正常解析，JSON 视为不完整结果。
test("translate 按内容嗅探响应类型", async () => {
    const sse = await translate(async () => new Response(
        "event: json\ndata: {\"code\":0,\"data\":{\"items\":[{\"index\":0,\"res\":\"你好\"}]}}\n\nevent: done\ndata: {}\n\n",
        {headers: {}},
    ));
    assert.deepEqual(expectResult(sse).texts, ["你好"]);

    const json = await translate(async () => new Response(JSON.stringify({code: 0}), {headers: {}}));
    expectError(json, "upstream_incomplete_result", false);

    // 既不是 JSON 也不像 SSE 的垃圾响应被拒绝。
    expectError(await translate(async () => new Response("z".repeat(200), {headers: {}})), "upstream_stream_error", false);
});

// application/json 响应也会检查业务码。
test("translate 校验 JSON 响应的业务码", async () => {
    const auth = await translate(async () => new Response(JSON.stringify({code: 710012001}), {headers: {"content-type": "application/json"}}));
    expectError(auth, "upstream_auth_error", false);

    const ok = await translate(async () => new Response(JSON.stringify({code: 0}), {headers: {"content-type": "application/json"}}));
    expectError(ok, "upstream_incomplete_result", false);
});

// ---------------------------------------------------------------- authStatus

// 用假 fetcher 调用 authStatus。
async function authStatus(fetcher: typeof fetch, providerFn: () => Promise<StoredCookie> = provider): Promise<AuthStatus> {
    const client = new DoubaoClient(config, fetcher, () => {});
    return client.authStatus(new AbortController().signal, providerFn);
}

// 业务码 0 表示登录有效。
test("authStatus 报告登录有效", async () => {
    let url: string | undefined;
    const status = await authStatus(async (input) => {
        url = String(input);
        return Response.json({code: 0});
    });
    assert.equal(url, "https://www.doubao.com/samantha/plugin/user_settings/get?frontend_source=1");
    assert.deepEqual(status, {
        authenticated: true,
        cookie_loaded: true,
        required_login_cookies_present: true,
        upstream_code: 0,
    });
});

// Cookie 过期与其他业务码要能区分开，便于提示重新登录。
test("authStatus 区分 Cookie 过期与其他登录问题", async () => {
    const expired = await authStatus(async () => Response.json({code: 710012001}));
    assert.equal(expired.authenticated, false);
    assert.equal(expired.reason, "cookie_expired");
    assert.equal(expired.upstream_code, 710012001);

    const other = await authStatus(async () => Response.json({code: 999}));
    assert.equal(other.reason, "upstream_auth_error");
});

// Cookie 不完整时直接返回，不发起上游请求。
test("authStatus 对不完整 Cookie 不请求上游", async () => {
    let called = false;
    const status = await authStatus(async () => {
        called = true;
        return Response.json({code: 0});
    }, async () => ({cookie: "sessionid=a", complete: false}));
    assert.equal(called, false);
    assert.deepEqual(status, {
        authenticated: false,
        cookie_loaded: true,
        required_login_cookies_present: false,
        reason: "cookie_invalid",
    });
});

// 网络类失败只如实返回错误码，不判定为登录失效，避免误让用户重新登录。
test("authStatus 不把网络失败当作登录失效", async () => {
    assert.equal((await authStatus(async () => {
        throw new Error("boom");
    })).reason, "upstream_network_error");
    assert.equal((await authStatus(async () => new Response("no", {status: 500}))).reason, "upstream_http_error");
});
