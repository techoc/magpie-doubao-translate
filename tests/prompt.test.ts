// 目标语言与提示词解析单元测试。
// 覆盖语言代码归一（normalizeLanguage）和从聊天提示词里解析目标语言 / 正文的逻辑。
// 运行方式：npm test（或 node --test tests/prompt.test.ts）

import assert from "node:assert/strict";
import { test } from "node:test";

import { aliases, languageNames, languages, normalizeLanguage } from "../src/doubao/languages.ts";
import { determineLanguage, extractSource } from "../src/core/prompt-parser.ts";
import { failedWith, failedWithParam } from "./helpers.ts";

// ---------------------------------------------------------------- languages

// 语言表本身要保持稳定：豆包接口只认这些取值。
test("语言表包含全部受支持的目标语言", () => {
    assert.deepEqual(languages, [
        "en", "ar", "de", "es", "es-ES", "fil", "fr", "id", "it", "ja", "ko",
        "ms", "pt", "ru", "th", "uz", "vi", "zh", "zh-Hant"
    ]);
    // 别名表的值必须都是规范代码，否则归一化会产生非法语言。
    for (const value of Object.values(aliases)) assert.ok(languages.includes(value), `${value} 不在语言表里`);
    // 名称表同理，且每种语言都要有可识别的名称（含中文名）。
    for (const [lang, names] of languageNames) {
        assert.ok(languages.includes(lang), `${lang} 不在语言表里`);
        assert.ok(names.length > 0 && names.every((name) => name.length > 0));
    }
});

// 归一化顺序：精确匹配 → 别名 → 忽略大小写 → 取语言子标签。
test("normalizeLanguage 归一化各种写法", () => {
    const cases: [string, string][] = [
        ["en-US", "en"],
        ["zh-cn", "zh"],
        ["zh-CN", "zh"],
        ["zh-TW", "zh-Hant"],
        ["zh-hk", "zh-Hant"],
        ["pt-BR", "pt"],
        ["es-ES", "es-ES"],
        ["es-MX", "es"],
        ["tl", "fil"],
        ["EN", "en"],
        ["JA", "ja"],
        ["  fr  ", "fr"],
        ["zh-Hant", "zh-Hant"],
    ];
    for (const [input, expected] of cases)
        assert.equal(normalizeLanguage(input), expected, `${input} 应归一为 ${expected}`);
});

// 无法识别的语言返回 400 + unsupported_target_language。
test("normalizeLanguage 拒绝不支持的语言", () => {
    for (const value of ["", "   ", "xx", "klingon"]) {
        assert.throws(
            () => normalizeLanguage(value),
            failedWithParam("unsupported_target_language", "target_lang", 400),
            `${value} 应被拒绝`,
        );
    }
});

// ---------------------------------------------------------------- determineLanguage

// 优先级：请求体 > 请求头 > 系统上下文 > 用户消息指令 > 默认语言。
test("determineLanguage 按优先级选取目标语言", () => {
    const contexts = ["Translate to French."];
    const user = "Translate to German: Hello";
    assert.equal(determineLanguage("ja", "ko", contexts, user, "zh"), "ja");
    assert.equal(determineLanguage(undefined, "ko", contexts, user, "zh"), "ko");
    assert.equal(determineLanguage(undefined, undefined, contexts, user, "zh"), "fr");
    assert.equal(determineLanguage(undefined, undefined, [], user, "zh"), "de");
    assert.equal(determineLanguage(undefined, undefined, [], "Hello", "zh"), "zh");
});

// 既没有指令也没有默认语言时同样报错，而不是返回空值。
test("determineLanguage 缺少默认语言时要求显式指定", () => {
    assert.throws(
        () => determineLanguage(undefined, undefined, [], "Hello", undefined),
        failedWith("target_language_required"),
    );
});

// 请求体 / 请求头同样要做语言归一，避免把别名直接送给上游。
test("determineLanguage 对请求体与请求头做归一化", () => {
    assert.equal(determineLanguage("zh-TW", undefined, [], "Hello", "zh"), "zh-Hant");
    assert.equal(determineLanguage(undefined, "pt-BR", [], "Hello", "zh"), "pt");
});

// 同一来源里出现多个不同语言时无法确定目标，直接报冲突。
test("determineLanguage 遇到同源语言冲突时报错", () => {
    assert.throws(
        () => determineLanguage(undefined, undefined, ["Translate to French.", "Translate to German."], "Hello", "zh"),
        failedWithParam("invalid_request", "target_lang"),
    );
});

// 提示词里写了翻译指令但语言名无法识别时，不回退默认语言，而是要求客户端补全语言。
test("determineLanguage 无法识别指令语言时要求显式指定", () => {
    assert.throws(
        () => determineLanguage(undefined, undefined, [], "Translate to Klingon: Hello", "zh"),
        failedWith("target_language_required", 400),
    );
    assert.throws(
        () => determineLanguage(undefined, undefined, ["请翻译成火星文：你好"], "你好", "zh"),
        failedWith("target_language_required"),
    );
});

// 没有任何指令时才使用 fallback。
test("determineLanguage 无指令时回退默认语言", () => {
    assert.equal(determineLanguage(undefined, undefined, [], "Just some text.", "zh-Hant"), "zh-Hant");
});

// ---------------------------------------------------------------- extractSource

// 指令前缀与「Text:」标签都要剥掉，只留正文。
test("extractSource 剥掉指令前缀与正文标签", () => {
    const cases: [string, string][] = [
        ["Translate to Chinese: Hello", "Hello"],
        ["Translate to Chinese:\n\nHello", "Hello"],
        ["Text: Hello", "Hello"],
        ["Source text: Hello", "Hello"],
        ["原文：Hello", "Hello"],
        ["请翻译成日语：こんにちは", "こんにちは"],
        ["请将以下内容翻译成英文：Hello world", "Hello world"],
        ["请把以下文字翻译成英语：Hello world", "Hello world"],
        ["把这段文字翻译成中文：Hello world", "Hello world"],
        ["Hello", "Hello"],
    ];
    for (const [input, expected] of cases)
        assert.equal(extractSource(input), expected, `${input} 应提取出 ${expected}`);
});

// 剥掉标签后没有正文同样视为空输入。
test("extractSource 拒绝剥完为空的输入", () => {
    for (const value of ["", "   ", "Translate to Chinese:", "Text:", "原文："]) {
        assert.throws(
            () => extractSource(value),
            failedWith("empty_translation_input", 400),
            `${value} 应被拒绝`,
        );
    }
});
