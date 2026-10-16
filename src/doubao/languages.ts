// 目标语言表。
//
//   languages    豆包接口直接接受的语言代码
//   aliases      常见别名（地区写法、大小写变体）到规范代码的映射
//   languageNames 提示词里可能出现的语言名称，用于从自然语言指令中识别目标语言

import { invalid } from "../core/errors.ts";

// 豆包 target_lang 参数接受的取值。
export const languages = ["en", "ar", "de", "es", "es-ES", "fil", "fr", "id", "it", "ja", "ko", "ms", "pt", "ru", "th", "uz", "vi", "zh", "zh-Hant"] as const;

// 规范语言代码（languages 的元素类型），用于约束归一化结果。
export type Language = (typeof languages)[number];

// 客户端传来的别名统一归一到上面的规范代码（键为小写）。
export const aliases: Record<string, Language> = {
    "zh-cn": "zh",
    "zh-hans": "zh",
    "zh-sg": "zh",
    "zh-tw": "zh-Hant",
    "zh-hk": "zh-Hant",
    "zh-hant": "zh-Hant",
    "zh-mo": "zh-Hant",
    "pt-br": "pt",
    "pt-pt": "pt",
    "es-419": "es",
    "es-mx": "es",
    "es-es": "es-ES",
    tl: "fil"
};

// 归一化顺序：精确匹配 → 别名 → 忽略大小写 → 取语言子标签（如 en-US → en）。
export function normalizeLanguage(value: string): Language {
    const key = value.trim();
    const lower = key.toLowerCase();
    // 顺序即优先级：先看原样，再看别名表，再看忽略大小写，最后退回主语言子标签。
    const match = languages.find((x) => x === key)
        ?? aliases[lower]
        ?? languages.find((x) => x.toLowerCase() === lower)
        ?? languages.find((x) => x === lower.split("-")[0]);
    if (!match) throw invalid("Unsupported target translation language.", "unsupported_target_language", "target_lang");
    return match;
}

// 每种规范代码对应的语言名称（含英文全称与中文），用于从提示词里识别目标语言。
// 匹配时的先后顺序由 prompt-parser 按名称长度排序决定，此处顺序不影响结果。
export const languageNames: [Language, string[]][] = [
    ["zh-Hant", ["Traditional Mandarin Chinese", "Traditional Chinese", "繁体中文", "繁體中文"]],
    ["zh", ["Simplified Mandarin Chinese", "Simplified Chinese", "Chinese", "简体中文", "中文"]],
    ["en", ["English", "英语", "英文"]],
    ["ja", ["Japanese", "日语", "日文", "日本語"]],
    ["ko", ["Korean", "韩语", "韩文", "한국어"]],
    ["fr", ["French", "法语"]],
    ["de", ["German", "德语"]],
    ["es-ES", ["European Spanish", "Spanish (Spain)"]],
    ["es", ["Spanish", "西班牙语"]],
    ["pt", ["Portuguese", "葡萄牙语"]],
    ["ru", ["Russian", "俄语"]],
    ["ar", ["Arabic", "阿拉伯语"]],
    ["it", ["Italian", "意大利语"]],
    ["id", ["Indonesian", "印尼语", "印度尼西亚语"]],
    ["ms", ["Malay", "马来语"]],
    ["th", ["Thai", "泰语"]],
    ["vi", ["Vietnamese", "越南语"]],
    ["fil", ["Filipino", "Tagalog", "菲律宾语"]],
    ["uz", ["Uzbek", "乌兹别克语"]]
];
