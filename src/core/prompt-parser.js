// 从聊天式提示词里解析「目标语言」和「待翻译正文」。
//
// 客户端（如陪读蛙）常把指令和正文写在同一条消息里，例如：
//   "请把下面这段文字翻译成简体中文：Hello world"
//   "Translate to Japanese:\n\nHello world"
// 这里先用语言名表匹配指令中的目标语言，再把指令前缀和「原文：」之类的标签剥掉，
// 只把真正的正文交给翻译接口。
import { invalid } from "./errors.js";
import { languageNames, languages, normalizeLanguage } from "../doubao/languages.js";
// 语言名要原样拼进正则，先转义其中的正则元字符。
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 语言名按长度倒序排列，保证「简体中文」优先于「中文」、
// 「Traditional Mandarin Chinese」优先于「Chinese」，避免短名抢先匹配。
const names = languageNames.flatMap(([lang, entries]) => entries.map((name) => ({
    lang,
    name
}))).concat(languages.map((lang) => ({ lang, name: lang }))).sort((a, b) => b.name.length - a.name.length);
const nameExpression = names.map((x) => escape(x.name)).join("|");
// 英文指令：translate ... to X / target language: X / output language: X
const english = new RegExp(`(?:\\btranslate\\b[^\\n:：]{0,160}?\\b(?:to|into)\\s+|\\b(?:target|output)\\s+language\\s*[:：]\\s*)(${nameExpression})(?![\\w-])`, "gi");
// 中文指令：翻译成 X / 译为 X / 目标语言：X
const chinese = new RegExp(`(?:翻译(?:成|为)|译为|目标语言\\s*[:：]\\s*)(${nameExpression})`, "gi");
// 返回文本中出现的所有目标语言（可能多个，由调用方判断是否冲突）。
function scan(text) {
    const found = [];
    for (const expression of [english, chinese]) {
        // 正则带 g 标志，复用时必须重置 lastIndex，否则会漏匹配。
        expression.lastIndex = 0;
        for (const match of text.matchAll(expression)) {
            // 捕获组一定存在（正则是 (${nameExpression})），空串兜底仅为满足类型收窄。
            const entry = names.find((x) => x.name.toLowerCase() === (match[1] ?? "").toLowerCase());
            if (entry)
                found.push(entry.lang);
        }
    }
    return found;
}
// 按优先级确定目标语言：
//   1. 请求体显式指定的 target_lang
//   2. 请求头 x-doubao-target-lang
//   3. 系统提示 / instructions 里声明的语言
//   4. 用户消息开头的指令前缀里声明的语言
//   5. 都没写指令时的插件默认语言（fallbackLanguage）
// 若同一来源里出现多个不同语言则报冲突，而不是随便挑一个。
export function determineLanguage(body, header, contexts, user, fallbackLanguage) {
    if (body !== undefined)
        return normalizeLanguage(body);
    if (header !== undefined)
        return normalizeLanguage(header);
    for (const values of [contexts.flatMap(scan), scan(instructionPrefix(user))]) {
        const unique = [...new Set(values)];
        if (unique.length > 1)
            throw invalid("Conflicting target translation languages.", "invalid_request", "target_lang");
        if (unique.length === 1)
            return unique[0];
    }
    // 只有当提示词里完全没有翻译指令时，才回退到默认语言；
    // 写了指令却没识别出语言（例如拼错语言名）应当报错，而不是静默用默认值。
    const directive = /(?:\btranslate\b[^\n:：]{0,160}\b(?:to|into)\s+|\b(?:target|output)\s+language\s*[:：]|翻译(?:成|为)|译为|目标语言\s*[:：])/i;
    if (fallbackLanguage && ![...contexts, instructionPrefix(user)].some((text) => directive.test(text)))
        return fallbackLanguage;
    throw invalid("Unable to determine target translation language.", "target_language_required", "target_lang");
}
// 提取消息开头的翻译指令前缀（含中英文写法），供剥除与语言扫描共用。
function instructionPrefix(user) {
    const prefix = user.match(/^(?:please\s+)?translate[^\n:：]{1,160}[:：][ \t]*(?:\r\n|\n|\r)*/i) ?? user.match(/^(?:请(?:将|把)?|将|把)?(?:下面(?:的)?(?:内容|文字|文本)?|以下(?:的)?(?:内容|文字|文本)?|这(?:段)?(?:文字|文本|内容))?[ \t]*(?:翻译(?:成|为)|译为)[^\n:：]{1,80}[:：][ \t]*(?:\r\n|\n|\r)*/) ?? user.match(/^(?:(?:Target|Output)\s+language|目标语言)\s*[:：][^\r\n]{1,80}(?:\r\n|\n|\r)+/i);
    return prefix?.[0] ?? "";
}
// 剥掉指令前缀和「Text:」「原文：」这类标签，得到真正要翻译的正文。
export function extractSource(user) {
    let text = user;
    const prefix = instructionPrefix(text);
    if (prefix)
        text = text.slice(prefix.length);
    const label = text.match(/^(?:Text|Source text|原文)\s*[:：][ \t]*(?:\r\n|\n|\r)?/i);
    if (label)
        text = text.slice(label[0].length);
    if (!text.trim())
        throw invalid("Translation input is empty.", "empty_translation_input");
    return text;
}
