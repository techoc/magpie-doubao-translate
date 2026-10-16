// Cookie 解析与读取。
//
// Magpie 插件的 Cookie 由宿主传入（见 admin/accounts.js），此处的文件读取只服务
// 于独立 API 服务版。两个入口共用同一套解析与安全校验。
import { readFile } from "node:fs/promises";
import { ServiceError } from "../core/errors.js";
// 解析 Cookie 请求头。complete 表示三个必需登录 Cookie 是否齐全，
// 不齐全不直接报错，交给调用方决定是拒绝还是仅提示。
export function parseCookie(text) {
    const cookie = text.trim().replace(/^Cookie:\s*/i, "");
    // 非 ASCII 字符或过长内容不能安全地放进请求头，直接拒绝。
    if (!cookie || cookie.length > 32768 || /[^\x20-\x7e]/.test(cookie))
        throw new ServiceError("cookie_invalid", 502, "Cookie is empty or contains unsafe header characters.");
    const entries = cookie.split(";").map((item) => item.trim());
    // 三个 Cookie 都必须有非空值，缺任意一个登录都不成立。
    const complete = ["sessionid", "sid_tt", "uid_tt"].every((name) => entries.some((item) => item.startsWith(`${name}=`) && item.length > name.length + 1));
    return { cookie, complete };
}
// 从文件读取并解析 Cookie，仅 API 服务版使用。
export async function loadCookie(path) {
    let text;
    try {
        text = await readFile(path, "utf8");
    }
    catch (error) {
        // 区分「文件不存在」和「读不了」，前者通常是还没配置。
        const missing = error.code === "ENOENT";
        throw new ServiceError(missing ? "cookie_missing" : "cookie_invalid", 502, missing ? "Cookie file is missing." : "Cookie file cannot be read.");
    }
    return parseCookie(text);
}
