// 翻译编排。
//
// 负责把一次请求拆成批次并串起来执行，中间处理四件事：
//   1. 并发闸门排队，避免同时打太多上游请求
//   2. 上游失败时按错误类型决定「重试同一账号」还是「换账号」
//   3. 整个请求的总超时预算，超时后中断所有在途调用
//   4. 汇总用量与耗时，交给可选的 usage 记录器

import { setTimeout as delay } from "node:timers/promises";
import { ServiceError, isServiceError } from "./errors.ts";
import { MODEL_ENGINE_MAP } from "./models.ts";
import { Semaphore } from "./concurrency.ts";
import { segmentText, buildBatches } from "./segmenter.ts";
import { isAccountFailure } from "../admin/accounts.ts";
import type { EnvConfig } from "../config/env.ts";
import type {
    AccountLease,
    AccountPool,
    AuthStatus,
    CanonicalRequest,
    CookieProvider,
    TranslationClient,
    TranslationResult,
    TranslationTrace,
    UsageRecorder
} from "../types.ts";

// 重试退避：250ms 起步、三倍递增，上限 5s，另加少量随机抖动避免同步重试。
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 5_000;
// 单次请求的译文总长度上限，防止异常上游把内存撑爆。
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export class Translator {
    readonly config: EnvConfig;
    // 只依赖客户端的两项能力（见 TranslationClient），不绑定具体实现。
    readonly client: TranslationClient;
    // 账号池与用量记录器都是可选的：插件版两者都不传。
    readonly pool: AccountPool | undefined;
    readonly usage: UsageRecorder | undefined;
    readonly semaphore: Semaphore;

    constructor(config: EnvConfig, client: TranslationClient, pool?: AccountPool, usage?: UsageRecorder) {
        this.config = config;
        this.client = client;
        this.pool = pool;
        this.usage = usage;
        this.semaphore = new Semaphore(config.DOUBAO_MAX_CONCURRENCY, config.DOUBAO_QUEUE_MAX, config.DOUBAO_QUEUE_TIMEOUT_MS);
    }

    // 入口：包一层总超时，并保证无论成败都记录用量。
    async translate(req: CanonicalRequest, signal: AbortSignal, provider?: CookieProvider): Promise<TranslationResult> {
        const start = performance.now();
        const deadline = new AbortController();
        const timer = setTimeout(
            () => deadline.abort(new ServiceError("translation_timeout", 504, "Translation exceeded its total time limit.")),
            this.config.DOUBAO_TOTAL_TIMEOUT_MS
        );
        // 客户端取消与总超时任一触发都中断下游请求。
        const combined = AbortSignal.any([signal, deadline.signal]);
        const trace: TranslationTrace = {upstreamCalls: 0, retries: 0, switches: 0, queueMs: 0};
        let code: string | undefined;
        try {
            return await this.run(req, combined, trace, provider);
        } catch (error) {
            // 超时中断时抛出的可能不是原始错误，统一按中断原因取 code。
            const failure = combined.aborted ? combined.reason : error;
            code = signal.aborted ? "client_cancelled" : isServiceError(failure) ? failure.code : "internal_error";
            throw failure;
        } finally {
            clearTimeout(timer);
            this.usage?.record(req, performance.now() - start, trace, code);
        }
    }

    private async run(
        req: CanonicalRequest,
        signal: AbortSignal,
        trace: TranslationTrace,
        provider: CookieProvider | undefined
    ): Promise<TranslationResult> {
        const start = performance.now();
        const segments = segmentText(req.rawText);
        const batches = buildBatches(segments.map((x) => x.text));
        // 译文按段下标回填，空行等未送上游的段保持原文。
        const translated = segments.map((x) => x.text);
        const detected = new Set<string>();
        // 指定了 provider（Magpie 单账号登录）时不用账号池。
        let lease: AccountLease | undefined = this.pool && !provider ? await this.pool.choose() : undefined;
        // 记录本次请求已用过的账号，避免故障切换时又选回同一个。
        const tried = new Set<string>(lease ? [lease.id] : []);
        let outputBytes = 0;
        for (const batch of batches) {
            let retries = 0;
            let attempts = 0;
            for (; ;) {
                const queueStart = performance.now();
                let release!: () => void;
                try {
                    release = await this.semaphore.acquire(signal);
                } finally {
                    trace.queueMs += performance.now() - queueStart;
                }
                let retry = false;
                let switched = false;
                try {
                    if (attempts++ > 0) trace.retries++;
                    trace.upstreamCalls++;
                    const result = await this.client.translate({
                        texts: batch.texts,
                        targetLang: req.targetLang,
                        scene: req.scene,
                        // model 已由 resolveModel 校验过，映射一定存在。
                        engine: MODEL_ENGINE_MAP[req.model] as string
                    }, signal, provider ?? lease?.provider);
                    outputBytes += result.texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
                    if (outputBytes > MAX_OUTPUT_BYTES)
                        throw new ServiceError("upstream_stream_error", 502, "Translated output exceeds size limit.");
                    batch.indexes.forEach((index, i) => {
                        translated[index] = result.texts[i] as string;
                    });
                    result.detectedLanguages.forEach((x) => detected.add(x));
                    if (lease) await this.pool!.succeeded(lease.id, lease.revision);
                } catch (error) {
                    if (signal.aborted) throw error;
                    // 账号级失败（Cookie 失效、超时、网络错误等）：先标记该账号，
                    // 若策略允许则换一个账号重试同一批。
                    if (lease && this.pool && isAccountFailure(error)) {
                        await this.pool.failed(lease.id, error, lease.revision);
                        if (await this.pool.allowsFailover()) {
                            try {
                                lease = await this.pool.choose(tried);
                                tried.add(lease.id);
                                switched = true;
                                retry = true;
                                trace.switches++;
                            } catch (selectionError) {
                                // 没有可用账号不算致命，继续走下面的普通重试判断。
                                if (!isServiceError(selectionError) || selectionError.code !== "no_available_cookie") throw selectionError;
                            }
                        }
                    }
                    if (!retry) {
                        // 只有上游明确标记可重试、且未超过重试次数时才重试。
                        if (!isServiceError(error) || !error.retryable || retries >= this.config.DOUBAO_MAX_RETRIES) throw error;
                        retry = true;
                    }
                } finally {
                    release();
                }
                if (!retry) break;
                // 换了账号说明失败原因已随账号一起被绕开，立刻重试；
                // 仍在同一账号上重试则退避，避免连续冲击上游。
                if (!switched) await delay(Math.min(RETRY_BASE_MS * 3 ** retries++, RETRY_MAX_MS) + Math.random() * 100, undefined, {signal});
            }
        }
        signal.throwIfAborted();
        return {
            model: req.model,
            // 逐段回填译文并按原分隔符拼回，保留原始换行与缩进。
            text: segments.map((x, i) => (translated[i] as string) + x.separator).join(""),
            detectedLanguages: [...detected],
            upstreamBatchCount: batches.length,
            elapsedMs: performance.now() - start
        };
    }

    // 登录状态检查同样占用并发额度，避免校验请求绕过限流。
    async authStatus(signal: AbortSignal, provider?: CookieProvider): Promise<AuthStatus> {
        const release = await this.semaphore.acquire(signal);
        try {
            if (provider) return await this.client.authStatus(signal, provider);
            if (this.pool) {
                const {activeId} = await this.pool.list();
                // activeId 来自 list()，正常情况下一定有对应 Cookie；沿用原有行为，
                // 账号在此期间被删除时由客户端按「登录缺失」处理。
                return await this.client.authStatus(signal, () => this.pool!.getCookie(activeId)!);
            }
            return await this.client.authStatus(signal);
        } finally {
            release();
        }
    }
}
