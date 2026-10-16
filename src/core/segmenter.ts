// 文本切分与分批。
//
// 豆包接口按「段落数组」返回译文，因此需要先把原文切成段：分段后只替换正文、
// 保留原有换行与缩进，译文才能与原排版对齐；再把多段合并成批，减少上游请求数。

import { invalid } from "./errors.ts";

const MAX_SEGMENT_CHARS = 9_000;   // 单段送上游前的拆分阈值
const MIN_SPLIT_CHARS = 4_500;     // 句末切分点低于该值则退化为硬切，避免分段过碎
const MAX_SEGMENTS = 10_000;       // 单次请求允许的最大段数
const MAX_BATCH_TEXTS = 50;        // 单个上游批次的段数上限
const MAX_BATCH_CHARS = 10_000;    // 单个上游批次的字符数上限

// 一段正文及其后面的分隔符。separator 原样保留换行与行尾空白，便于回填。
export interface Segment {
    text: string;
    separator: string;
}

// 一个上游批次：indexes 是各段在原始数组中的下标，texts 是对应正文。
export interface Batch {
    indexes: number[];
    texts: string[];
}

export function segmentText(text: string): Segment[] {
    if (!text.trim()) throw invalid("Translation input is empty.", "empty_translation_input");
    const segments: Segment[] = [];
    // 捕获组会保留分隔符：偶数下标是正文，奇数下标是紧随其后的连续换行。
    const parts = text.split(/((?:\r\n|\r|\n)+)/);
    for (let i = 0; i < parts.length; i += 2) {
        let rest = parts[i] ?? "";
        const separator = parts[i + 1] ?? "";
        // 空行本身也要占一个段，否则连续空行会在拼接时丢失。
        if (!rest.trim()) {
            if (rest || separator) segments.push({text: "", separator: rest + separator});
            continue;
        }
        // 单段超过上限时继续切细，避免超出上游单段长度限制。
        while (rest.length > MAX_SEGMENT_CHARS) {
            const prefix = rest.slice(0, MAX_SEGMENT_CHARS);
            // 优先在句末切：取前缀里最后一个句子边界。
            const boundaries = [...prefix.matchAll(/[.!?。！？](?:\s+|$)/g)];
            const last = boundaries.at(-1);
            let end = last?.index !== undefined ? last.index + last[0].length : MAX_SEGMENT_CHARS;
            // 句子边界太靠前会让分段过碎，此时退化为按上限硬切。
            if (end < MIN_SPLIT_CHARS) end = MAX_SEGMENT_CHARS;
            // 避免把一个代理对（emoji 等）从中间劈开，导致出现孤立半个字符。
            if (/[\uD800-\uDBFF]/.test(rest[end - 1] ?? "")) end--;
            const piece = rest.slice(0, end);
            // 行尾空白挪到 separator，不让它进入待翻译正文。
            const whitespace = piece.match(/[ \t]+$/)?.[0] ?? "";
                segments.push({text: piece.slice(0, piece.length - whitespace.length), separator: whitespace});
            rest = rest.slice(end);
            if (segments.length > MAX_SEGMENTS) throw invalid("Too many translation segments.");
        }
        segments.push({text: rest, separator});
        if (segments.length > MAX_SEGMENTS) throw invalid("Too many translation segments.");
    }
    if (segments.length > MAX_SEGMENTS) throw invalid("Too many translation segments.");
    return segments;
}

// 把多段正文合并成上游请求批次：每批最多 50 段、合计不超过 10000 字符。
// batches[].indexes 记录每段在原始数组中的位置，用于把译文放回正确的位置。
export function buildBatches(texts: string[]): Batch[] {
    const batches: Batch[] = [];
    let batch: Batch = {indexes: [], texts: []};
    let chars = 0;
    texts.forEach((text, index) => {
        // 空段（纯空行）不送上游，直接沿用原文。
        if (!text) return;
        if (text.length > MAX_BATCH_CHARS) throw invalid("Segment exceeds batch limit.");
        if (batch.texts.length >= MAX_BATCH_TEXTS || chars + text.length > MAX_BATCH_CHARS) {
            batches.push(batch);
            batch = {indexes: [], texts: []};
            chars = 0;
        }
        batch.texts.push(text);
        batch.indexes.push(index);
        chars += text.length;
    });
    if (batch.texts.length) batches.push(batch);
    return batches;
}
