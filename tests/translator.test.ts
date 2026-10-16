// 翻译编排单元测试。
// 覆盖 Translator 的重试、退避、故障切换、总超时、批次切分与用量记录。
// 运行方式：npm test（或 node --test tests/translator.test.ts）

import assert from "node:assert/strict";
import { test } from "node:test";

import { Translator } from "../src/core/translator.ts";
import { loadConfig } from "../src/config/env.ts";
import { ServiceError } from "../src/core/errors.ts";
import type {
    AccountPool,
    CanonicalRequest,
    CookieProvider,
    TranslationClient,
    TranslationResult,
    TranslationTrace,
    UpstreamTranslateRequest,
    UpstreamTranslateResult,
    UsageRecorder
} from "../src/types.ts";
import { serviceError } from "./helpers.ts";

// 构造配置：其余字段用默认值；测试不依赖真实 Cookie 文件。
const makeConfig = (env: Record<string, string> = {}) =>
    loadConfig({DOUBAO_COOKIE_FILE: "/tmp/translator-test-missing.txt", ...env});
const CONFIG = makeConfig();
const REQ: CanonicalRequest = {
    protocol: "openai-chat",
    model: "doubao-ai",
    targetLang: "zh",
    rawText: "Hello",
    stream: false,
    scene: 2,
    requestId: "req-1"
};

// 用量记录器的一次调用：[请求, 耗时, 轨迹, 错误码]。
type UsageCall = [CanonicalRequest, number, TranslationTrace, string | undefined];

// 收集用量记录器的调用，便于断言耗时、重试轨迹与错误码。
function recorder(): {calls: UsageCall[]; usage: UsageRecorder} {
    const calls: UsageCall[] = [];
    return {
        calls,
        usage: {
            record: (request, elapsedMs, trace, code) => {
                calls.push([request, elapsedMs, trace, code]);
            }
        }
    };
}

// 固定的假客户端：按脚本依次返回结果或抛错，最后一次会被重复使用。
// 只实现 TranslationClient 的两个方法，其余能力与编排无关。
type Step = UpstreamTranslateResult | ((req: UpstreamTranslateRequest, signal: AbortSignal) => UpstreamTranslateResult);

interface ScriptedClient extends TranslationClient {
    state: {calls: number; requests: UpstreamTranslateRequest[]; providers: (CookieProvider | undefined)[]};
}

// 返回带调用记录的客户端：满足 TranslationClient，并额外暴露 state。
function scriptedClient(steps: Step[]): ScriptedClient {
    const state: ScriptedClient["state"] = {calls: 0, requests: [], providers: []};
    return {
        state,
        async authStatus() {
            return {authenticated: true, cookie_loaded: true, required_login_cookies_present: true};
        },
        async translate(req, signal, provider) {
            state.calls++;
            state.requests.push(req);
            state.providers.push(provider);
            const step = steps[Math.min(state.calls - 1, steps.length - 1)];
            if (!step) throw new Error("step 不应为空");
            return typeof step === "function" ? step(req, signal) : step;
        }
    };
}

// 账号池替身：只覆盖用例关心的行为，其余用安全默认值补齐。
function poolOf(overrides: Partial<AccountPool> = {}): AccountPool {
    return {
        async choose() {
            return {id: "a", revision: "r1", provider: async () => ({cookie: "c", complete: true})};
        },
        async succeeded() {
        },
        async failed() {
        },
        async allowsFailover() {
            return false;
        },
        async list() {
            return {activeId: "a"};
        },
        getCookie() {
            return {cookie: "c", complete: true};
        },
        ...overrides
    };
}

const ok = (text = "你好", detectedLanguages = ["en"]): UpstreamTranslateResult => ({texts: [text], detectedLanguages});

// 在给定 signal 下执行翻译，把成功与失败都收敛成结果对象。
async function run(
    translator: Translator,
    req: CanonicalRequest = REQ,
    signal: AbortSignal = new AbortController().signal,
    provider?: CookieProvider
): Promise<{result?: TranslationResult; error?: unknown}> {
    try {
        return {result: await translator.translate(req, signal, provider)};
    } catch (error) {
        return {error};
    }
}

const expectResult = (outcome: {result?: TranslationResult; error?: unknown}): TranslationResult => {
    if (!outcome.result) throw new Error(`期望成功返回，实际：${String(outcome.error)}`);
    return outcome.result;
};

const expectError = (outcome: {error?: unknown}, code: string): ServiceError => {
    const error = serviceError(outcome.error);
    assert.equal(error.code, code);
    return error;
};

// 按下标取用量记录，越界直接报错（noUncheckedIndexedAccess 下也不啰嗦）。
const usageCall = (calls: UsageCall[], index: number): UsageCall => {
    const value = calls[index];
    if (!value) throw new Error(`期望第 ${index} 条用量记录存在，实际只有 ${calls.length} 条`);
    return value;
};

// ---------------------------------------------------------------- 正常路径

// 单批成功时直接返回译文，并汇总元信息。
test("Translator 返回译文与批次元信息", async () => {
    const {usage, calls} = recorder();
    const client = scriptedClient([ok()]);
    const translator = new Translator(CONFIG, client, undefined, usage);
    const result = expectResult(await run(translator));
    assert.equal(result.model, "doubao-ai");
    assert.equal(result.text, "你好");
    assert.deepEqual(result.detectedLanguages, ["en"]);
    assert.equal(result.upstreamBatchCount, 1);
    assert.equal(typeof result.elapsedMs, "number");
    // 请求被原样透传给客户端（engine 已由模型映射得到）。
    assert.deepEqual(client.state.requests[0], {texts: ["Hello"], targetLang: "zh", scene: 2, engine: "1"});
    assert.equal(calls.length, 1);
});

// 段落切分后按原分隔符拼回，空行与换行都保留。
test("Translator 按原分隔符拼回多段译文", async () => {
    const client = scriptedClient([{texts: ["A", "B", "C"], detectedLanguages: []}]);
    const translator = new Translator(CONFIG, client);
    const result = expectResult(await run(translator, {...REQ, rawText: "a\n\nb\nc"}));
    assert.equal(result.text, "A\n\nB\nC");
    // 空行不送上游，只送三段正文。
    assert.deepEqual(client.state.requests[0]?.texts, ["a", "b", "c"]);
});

// 多批请求按批次下标回填译文。
test("Translator 合并多批结果", async () => {
    // 记录每一批送上游的正文，并把译文转成大写便于区分。
    const batches: string[][] = [];
    const client: TranslationClient = {
        ...scriptedClient([ok()]),
        async translate(req) {
            batches.push(req.texts);
            return {texts: req.texts.map((text) => text.toUpperCase()), detectedLanguages: ["en"]};
        }
    };
    const translator = new Translator(CONFIG, client);
    // 51 段会拆成 50 + 1 两批。
    const rawText = Array.from({length: 51}, (_, i) => `line ${i}`).join("\n\n");
    const result = expectResult(await run(translator, {...REQ, rawText}));
    assert.equal(result.upstreamBatchCount, 2);
    assert.deepEqual(batches.map((texts) => texts.length), [50, 1]);
    assert.match(result.text, /^LINE 0\n\nLINE 1/);
    assert.match(result.text, /LINE 50$/);
});

// 译文总长度超过上限时中止，防止异常上游撑爆内存。
test("Translator 限制译文总大小", async () => {
    const client = scriptedClient([() => ({texts: ["x".repeat(9 * 1024 * 1024)], detectedLanguages: []})]);
    const translator = new Translator(CONFIG, client);
    expectError(await run(translator), "upstream_stream_error");
});

// ---------------------------------------------------------------- 重试

// 上游标记可重试时退避后重试同一批，直到成功。
test("Translator 对可重试错误重试后成功", async () => {
    const {usage, calls} = recorder();
    const client = scriptedClient([
        () => {
            throw new ServiceError("upstream_network_error", 502, "boom", true);
        },
        ok(),
    ]);
    const translator = new Translator(CONFIG, client, undefined, usage);
    const result = expectResult(await run(translator));
    assert.equal(result.text, "你好");
    assert.equal(client.state.calls, 2);
    // 轨迹里记录了重试次数与上游调用次数。
    assert.equal(usageCall(calls, 0)[2].retries, 1);
    assert.equal(usageCall(calls, 0)[2].upstreamCalls, 2);
    assert.equal(usageCall(calls, 0)[3], undefined);
});

// 不可重试的错误立即抛出，不浪费上游调用。
test("Translator 对不可重试错误立即失败", async () => {
    const {usage, calls} = recorder();
    const client = scriptedClient([() => {
        throw new ServiceError("model_not_found", 404, "nope", false);
    }]);
    const translator = new Translator(CONFIG, client, undefined, usage);
    expectError(await run(translator), "model_not_found");
    assert.equal(client.state.calls, 1);
    // 失败也要记录用量，错误码透传。
    assert.equal(usageCall(calls, 0)[3], "model_not_found");
});

// 重试次数用尽后抛出最后一个错误（默认 2 次重试 = 3 次调用）。
test("Translator 重试耗尽后抛出错误", async () => {
    const {usage, calls} = recorder();
    const client = scriptedClient([() => {
        throw new ServiceError("upstream_network_error", 502, "boom", true);
    }]);
    const translator = new Translator(CONFIG, client, undefined, usage);
    expectError(await run(translator), "upstream_network_error");
    assert.equal(client.state.calls, 3);
    assert.equal(usageCall(calls, 0)[2].retries, 2);
});

// DOUBAO_MAX_RETRIES 为 0 时只尝试一次。
test("Translator 尊重 maxRetries 配置", async () => {
    const client = scriptedClient([() => {
        throw new ServiceError("upstream_network_error", 502, "boom", true);
    }]);
    const translator = new Translator(makeConfig({DOUBAO_MAX_RETRIES: "0"}), client);
    await run(translator);
    assert.equal(client.state.calls, 1);
});

// ---------------------------------------------------------------- 故障切换

// 账号级失败时标记该账号并换一个账号重试同一批。
test("Translator 在账号失败时切换账号", async () => {
    const log: unknown[][] = [];
    const pool = poolOf({
        async choose(exclude) {
            const id = exclude?.size ? "b" : "a";
            log.push(["choose", id]);
            return {id, revision: "r1", provider: async () => ({cookie: id, complete: true})};
        },
        async succeeded(id) {
            log.push(["succeeded", id]);
        },
        async failed(id, error) {
            log.push(["failed", id, (error as ServiceError).code]);
        },
        async allowsFailover() {
            return true;
        }
    });
    const {usage, calls} = recorder();
    const client = scriptedClient([
        () => {
            throw new ServiceError("cookie_invalid", 502, "expired");
        },
        ok(),
    ]);
    const translator = new Translator(CONFIG, client, pool, usage);
    const result = expectResult(await run(translator));
    assert.equal(result.text, "你好");
    // 第一次用 a 失败，切换到 b 后成功。
    assert.deepEqual(log, [["choose", "a"], ["failed", "a", "cookie_invalid"], ["choose", "b"], ["succeeded", "b"]]);
    assert.equal(usageCall(calls, 0)[2].switches, 1);
    // 换了账号说明失败原因已被绕开，不再退避等待（最小退避为 250ms）。
    assert.ok(usageCall(calls, 0)[1] < 250, `不应退避等待，实际耗时 ${Math.round(usageCall(calls, 0)[1])}ms`);
    // 客户端拿到的 provider 来自切换后的账号。
    assert.equal((await client.state.providers[1]?.())?.cookie, "b");
});

// 策略不允许切换时直接失败，不做无谓尝试。
test("Translator 在禁止切换时不换账号", async () => {
    const log: unknown[][] = [];
    const pool = poolOf({
        async failed(id, error) {
            log.push(["failed", id, (error as ServiceError).code]);
        }
    });
    const client = scriptedClient([() => {
        throw new ServiceError("cookie_invalid", 502, "expired");
    }]);
    const translator = new Translator(CONFIG, client, pool);
    expectError(await run(translator), "cookie_invalid");
    assert.equal(client.state.calls, 1);
    assert.deepEqual(log, [["failed", "a", "cookie_invalid"]]);
});

// 没有其他可用账号时退回普通的可重试判断（此例中 cookie_invalid 不可重试）。
test("Translator 在无可用账号时按原错误处理", async () => {
    const pool = poolOf({
        async choose(exclude) {
            if (exclude?.size) throw new ServiceError("no_available_cookie", 502, "none");
            return {id: "a", revision: "r1", provider: async () => ({cookie: "a", complete: true})};
        },
        async allowsFailover() {
            return true;
        }
    });
    const client = scriptedClient([() => {
        throw new ServiceError("cookie_invalid", 502, "expired");
    }]);
    const translator = new Translator(CONFIG, client, pool);
    expectError(await run(translator), "cookie_invalid");
    assert.equal(client.state.calls, 1);
});

// 指定了 provider（Magpie 单账号登录）时不使用账号池。
test("Translator 在有 provider 时忽略账号池", async () => {
    const pool = poolOf({
        async choose() {
            throw new Error("不应调用账号池");
        }
    });
    const client = scriptedClient([ok()]);
    const translator = new Translator(CONFIG, client, pool);
    const provider: CookieProvider = async () => ({cookie: "c", complete: true});
    const result = await translator.translate(REQ, new AbortController().signal, provider);
    assert.equal(result.text, "你好");
    assert.equal(client.state.providers[0], provider);
});

// ---------------------------------------------------------------- 超时与取消

// 超过总超时预算时中断在途调用，抛出 translation_timeout（504）。
test("Translator 超时后抛出 504", async () => {
    const {usage, calls} = recorder();
    const config = makeConfig({DOUBAO_MAX_RETRIES: "0", DOUBAO_TOTAL_TIMEOUT_MS: "80"});
    // 永远挂起直到被中断，用来触发总超时。
    const client: TranslationClient = {
        ...scriptedClient([ok()]),
        async translate(_req, signal) {
            await new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason));
            });
            return ok();
        }
    };
    const translator = new Translator(config, client, undefined, usage);
    const error = expectError(await run(translator), "translation_timeout");
    assert.equal(error.status, 504);
    // 用量记录器仍会被调用，错误码为超时。
    assert.equal(usageCall(calls, 0)[3], "translation_timeout");
});

// 调用方中断时错误码记录为 client_cancelled。
test("Translator 记录调用方取消", async () => {
    const {usage, calls} = recorder();
    // 已中断的 signal 不会再触发 abort 事件，所以先检查一次状态。
    const client: TranslationClient = {
        ...scriptedClient([ok()]),
        async translate(_req, signal) {
            signal.throwIfAborted();
            await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
            return ok();
        }
    };
    const translator = new Translator(CONFIG, client, undefined, usage);
    const controller = new AbortController();
    const pending = run(translator, REQ, controller.signal);
    controller.abort(new ServiceError("client_cancelled", 499, "cancelled"));
    expectError(await pending, "client_cancelled");
    assert.equal(usageCall(calls, 0)[3], "client_cancelled");
});

// ---------------------------------------------------------------- 用量记录

// 用量记录器接收请求、耗时、轨迹与错误码四类信息。
test("Translator 在 finally 中记录用量", async () => {
    const {usage, calls} = recorder();
    const client = scriptedClient([ok()]);
    const translator = new Translator(CONFIG, client, undefined, usage);
    await run(translator);
    assert.equal(calls.length, 1);
    const [req, elapsed, trace, code] = usageCall(calls, 0);
    assert.equal(req, REQ);
    assert.equal(typeof elapsed, "number");
    assert.ok(elapsed >= 0);
    assert.deepEqual(Object.keys(trace).sort(), ["queueMs", "retries", "switches", "upstreamCalls"]);
    assert.equal(code, undefined);
});

// 未提供记录器时不应报错。
test("Translator 允许省略用量记录器", async () => {
    const translator = new Translator(CONFIG, scriptedClient([ok()]));
    const result = expectResult(await run(translator));
    assert.equal(result.text, "你好");
});

// ---------------------------------------------------------------- 并发闸门与登录检查

// 并发上限为 1 时，多个请求必须串行执行。
test("Translator 通过信号量限制并发", async () => {
    const config = makeConfig({DOUBAO_MAX_CONCURRENCY: "1"});
    let active = 0;
    let peak = 0;
    const client: TranslationClient = {
        ...scriptedClient([ok()]),
        async translate() {
            peak = Math.max(peak, ++active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active--;
            return ok();
        }
    };
    const translator = new Translator(config, client);
    await Promise.all([run(translator), run(translator), run(translator)]);
    assert.equal(peak, 1);
});

// authStatus 按有无 provider / 账号池分别解析 Cookie 来源。
test("Translator.authStatus 传递 Cookie 来源", async () => {
    // 记录编排层交给客户端的 provider，再调用它看最终解析出哪个 Cookie。
    const seen: (CookieProvider | undefined)[] = [];
    const client: TranslationClient = {
        ...scriptedClient([ok()]),
        async authStatus(_signal, provider) {
            seen.push(provider);
            const cookie = provider ? await provider() : undefined;
            return {
                authenticated: true,
                cookie_loaded: true,
                required_login_cookies_present: true,
                ...cookie ? {reason: cookie.cookie} : {}
            };
        }
    };
    const pool = poolOf({
        getCookie(id: string) {
            return {cookie: id, complete: true};
        }
    });
    const withPool = new Translator(CONFIG, client, pool);
    // 账号池模式：provider 取当前激活账号（poolOf 默认 activeId 为 a）的 Cookie。
    await withPool.authStatus(new AbortController().signal);
    const pooled = seen[0];
    assert.ok(pooled, "账号池模式应当提供 provider");
    assert.equal((await pooled()).cookie, "a");

    // 显式传入 provider 时优先使用它，不再走账号池。
    const provider: CookieProvider = async () => ({cookie: "direct", complete: true});
    await withPool.authStatus(new AbortController().signal, provider);
    assert.equal(seen[1], provider);

    // 既没有 provider 也没有账号池时走默认 Cookie 文件路径。
    const bare = new Translator(CONFIG, client);
    await bare.authStatus(new AbortController().signal);
    assert.equal(seen[2], undefined);
});

// 队列满时翻译请求以 429 失败，且不消耗上游调用。
test("Translator 在队列满时返回 429", async () => {
    const config = makeConfig({DOUBAO_MAX_CONCURRENCY: "1", DOUBAO_QUEUE_MAX: "0"});
    const client: TranslationClient = {
        ...scriptedClient([ok()]),
        async translate() {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return ok();
        }
    };
    const translator = new Translator(config, client);
    const [first, second] = await Promise.all([run(translator), run(translator)]);
    assert.equal(first.result?.text ?? serviceError(first.error).code, "你好");
    const error = serviceError(second.error);
    assert.equal(error.code, "queue_full");
    assert.equal(error.status, 429);
});
