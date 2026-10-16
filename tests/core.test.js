// 核心基础模块单元测试：错误类型、模型目录、并发闸门、文本切分与分批。
// 运行方式：npm test（或 node --test tests/core.test.ts）
import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceError, asServiceError, invalid } from "../src/core/errors.js";
import { MODEL_ENGINE_MAP, models, resolveModel } from "../src/core/models.js";
import { Semaphore } from "../src/core/concurrency.js";
import { buildBatches, segmentText } from "../src/core/segmenter.js";
import { failedWith, serviceError } from "./helpers.js";
// ---------------------------------------------------------------- errors
// invalid() 是「调用方错误」的简写：400、不可重试，默认错误码 invalid_request。
test("invalid() 构造 400 且不可重试的调用方错误", () => {
    const error = invalid("bad input", "custom_code", "field");
    assert.ok(error instanceof ServiceError);
    assert.equal(error.code, "custom_code");
    assert.equal(error.status, 400);
    assert.equal(error.message, "bad input");
    assert.equal(error.retryable, false);
    assert.equal(error.param, "field");
    // 未显式传入时 param 默认为 null。
    assert.equal(invalid("x").param, null);
    assert.equal(invalid("x").code, "invalid_request");
});
// ServiceError 需要稳定承载上游错误码与 HTTP 状态，供登录失效判定使用。
test("ServiceError 保留上游业务码与状态", () => {
    const error = new ServiceError("upstream_http_error", 502, "boom", true, null, 710012001, 429);
    assert.equal(error.upstreamCode, 710012001);
    assert.equal(error.upstreamStatus, 429);
    assert.equal(error.retryable, true);
    // Error 子类的 name / message / instanceof 行为正常。
    assert.ok(error instanceof Error);
    assert.equal(error.message, "boom");
});
// asServiceError 把非本类型异常收敛成 500，避免内部细节泄漏到响应体。
test("asServiceError 透传原错误并包装未知异常", () => {
    const known = invalid("nope");
    assert.equal(asServiceError(known), known);
    const wrapped = asServiceError(new TypeError("secret detail"));
    assert.equal(wrapped.code, "internal_error");
    assert.equal(wrapped.status, 500);
    assert.equal(wrapped.message, "Internal service error.");
});
// ---------------------------------------------------------------- models
// 模型 id 到豆包 translate_service 取值的映射是协议契约的一部分。
test("模型目录与豆包引擎取值一一对应", () => {
    assert.deepEqual(MODEL_ENGINE_MAP, {
        "doubao-ai": "1",
        "volcengine-translate": "0",
        "microsoft-translator": "3"
    });
    assert.deepEqual(models.map((model) => model.id), Object.keys(MODEL_ENGINE_MAP));
    assert.deepEqual(models.map((model) => model.owned_by), ["doubao", "volcengine", "microsoft"]);
    for (const model of models) {
        assert.equal(model.object, "model");
        assert.equal(model.type, "model");
        assert.equal(model.created, 0);
        assert.ok(typeof model.display_name === "string" && model.display_name.length > 0);
    }
});
// 未知模型返回 404（而不是 400），并把出错字段标为 model。
test("resolveModel 只接受已知模型", () => {
    assert.equal(resolveModel("doubao-ai"), "doubao-ai");
    // 错误码与状态是协议契约的一部分，逐项断言。
    let caught;
    try {
        resolveModel("nope");
    }
    catch (error) {
        caught = error;
    }
    const error = serviceError(caught);
    assert.equal(error.code, "model_not_found");
    assert.equal(error.status, 404);
    assert.equal(error.param, "model");
});
// ---------------------------------------------------------------- Semaphore
// 未达并发上限时应立刻放行，并在 release 后归还额度。
test("Semaphore 在额度内立即放行并可释放", async () => {
    const semaphore = new Semaphore(2, 4, 1_000);
    assert.deepEqual(semaphore.status, { active: 0, queued: 0, limit: 2, maxQueue: 4 });
    const release = await semaphore.acquire(new AbortController().signal);
    assert.deepEqual(semaphore.status, { active: 1, queued: 0, limit: 2, maxQueue: 4 });
    release();
    assert.equal(semaphore.status.active, 0);
});
// 重复 release 必须是 no-op，避免多放行一个请求。
test("Semaphore 重复 release 不会多释放额度", async () => {
    const semaphore = new Semaphore(1, 4, 1_000);
    const release = await semaphore.acquire(new AbortController().signal);
    release();
    release();
    assert.equal(semaphore.active, 0);
    // 额度已正确归还，还能再取一次。
    await semaphore.acquire(new AbortController().signal);
    assert.equal(semaphore.active, 1);
});
// 排队长度达上限时立即失败，返回 429。
test("Semaphore 队列满时以 429 拒绝", async () => {
    const semaphore = new Semaphore(1, 1, 200);
    const held = await semaphore.acquire(new AbortController().signal);
    // 先占满唯一的排队位；这次调用会一直等待，最后按超时失败。
    const queued = semaphore.acquire(new AbortController().signal).catch((error) => error);
    assert.equal(semaphore.status.queued, 1);
    await assert.rejects(() => semaphore.acquire(new AbortController().signal), (error) => error instanceof ServiceError && error.code === "queue_full" && error.status === 429);
    assert.equal((await queued).code, "queue_timeout");
    held();
});
// 排队超时返回 503。
test("Semaphore 排队超时返回 503", async () => {
    const semaphore = new Semaphore(1, 4, 20);
    const held = await semaphore.acquire(new AbortController().signal);
    await assert.rejects(() => semaphore.acquire(new AbortController().signal), (error) => error instanceof ServiceError && error.code === "queue_timeout" && error.status === 503);
    assert.equal(semaphore.status.queued, 0);
    held();
});
// 已中断的 signal 直接抛出其 reason，不进入排队。
test("Semaphore 已中断的 signal 立即失败", async () => {
    const semaphore = new Semaphore(1, 4, 1_000);
    const controller = new AbortController();
    const reason = new Error("client gone");
    controller.abort(reason);
    await assert.rejects(() => semaphore.acquire(controller.signal), (error) => error === reason);
    assert.equal(semaphore.status.active, 0);
});
// 排队期间中断应把等待者从队列中摘除，并以中断原因为拒绝理由。
test("Semaphore 排队期间中断会出队", async () => {
    const semaphore = new Semaphore(1, 4, 5_000);
    const held = await semaphore.acquire(new AbortController().signal);
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const waiting = semaphore.acquire(controller.signal);
    assert.equal(semaphore.status.queued, 1);
    controller.abort(reason);
    await assert.rejects(() => waiting, (error) => error === reason);
    assert.equal(semaphore.status.queued, 0);
    held();
});
// 释放时把额度让给队首等待者，等待者拿到额度后无需重新排队。
test("Semaphore 释放后队首等待者被唤醒", async () => {
    const semaphore = new Semaphore(1, 4, 5_000);
    const held = await semaphore.acquire(new AbortController().signal);
    const waiting = semaphore.acquire(new AbortController().signal);
    assert.equal(semaphore.status.queued, 1);
    held();
    const release = await waiting;
    assert.equal(semaphore.active, 1);
    assert.equal(semaphore.status.queued, 0);
    release();
});
// ---------------------------------------------------------------- segmentText
// 段落切分必须保留原始换行符，才能在回填译文时还原排版。
test("segmentText 保留段间分隔符", () => {
    assert.deepEqual(segmentText("a\n\nb"), [
        { text: "a", separator: "\n\n" },
        { text: "b", separator: "" },
    ]);
    // CRLF 视为一个分隔符整体保留。
    assert.deepEqual(segmentText("a\r\nb"), [
        { text: "a", separator: "\r\n" },
        { text: "b", separator: "" },
    ]);
    // 文件开头的空行也占一个段，否则拼接时会丢失。
    assert.deepEqual(segmentText("\n\na"), [
        { text: "", separator: "\n\n" },
        { text: "a", separator: "" },
    ]);
});
// 纯空白输入没有可翻译内容，直接报错。
test("segmentText 拒绝空输入", () => {
    for (const value of ["", "   ", "\n\n", "\t\r\n"]) {
        assert.throws(() => segmentText(value), failedWith("empty_translation_input", 400));
    }
});
// 超长单段没有可用句子边界时按上限硬切。
test("segmentText 对超长段按上限硬切", () => {
    const segments = segmentText("a".repeat(9_500));
    assert.deepEqual(segments.map((segment) => segment.text.length), [9_000, 500]);
    // 硬切产生的两段同属一个原始段落，第二段没有额外分隔符。
    assert.equal(segments[0]?.separator, "");
    assert.equal(segments[1]?.separator, "");
});
// 有句子边界时优先在句末切分，切点须落在 4500 字符之后，避免分段过碎。
test("segmentText 优先在句末切分超长段", () => {
    const segments = segmentText("Hello there. ".repeat(900));
    assert.deepEqual(segments.map((segment) => segment.text.length), [8_995, 2_704]);
    for (const segment of segments)
        assert.match(segment.text, /\.\s?$/);
});
// ---------------------------------------------------------------- buildBatches
// 空段（空行）不送上游，只记录非空段的下标。
test("buildBatches 跳过空段并保留下标", () => {
    assert.deepEqual(buildBatches(["a", "", "b"]), [{ indexes: [0, 2], texts: ["a", "b"] }]);
    assert.deepEqual(buildBatches([]), []);
    assert.deepEqual(buildBatches(["", ""]), []);
});
// 单批最多 50 段。
test("buildBatches 按段数上限拆批", () => {
    const texts = Array.from({ length: 51 }, (_, i) => `line ${i}`);
    const batches = buildBatches(texts);
    assert.deepEqual(batches.map((batch) => batch.texts.length), [50, 1]);
    assert.deepEqual(batches[1]?.indexes, [50]);
});
// 单批字符数上限 10000，超出即换批。
test("buildBatches 按字符数上限拆批", () => {
    const batches = buildBatches(["a".repeat(6_000), "b".repeat(6_000)]);
    assert.deepEqual(batches.map((batch) => batch.texts.length), [1, 1]);
    assert.deepEqual(batches.map((batch) => batch.indexes), [[0], [1]]);
});
// 单段超过批上限时无法再切，直接报错。
test("buildBatches 拒绝超过批上限的单段", () => {
    assert.throws(() => buildBatches(["x".repeat(10_001)]), failedWith("invalid_request", 400));
});
