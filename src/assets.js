// 供应商图标加载。
//
// 图标以 data URL 内嵌返回，本机与远端安装都无须再下载图片。
// 路径相对本模块解析：src/assets.js 与打包后的 dist/index.mjs 都位于包根下
// 一层，因此 "../assets/icon-magpie.png" 在两种布局下都指向同一文件。
import { readFile } from "node:fs/promises";
const ICON_URL = new URL("../assets/icon-magpie.png", import.meta.url);
export async function loadProviderIcon() {
    const png = await readFile(ICON_URL);
    return "data:image/png;base64," + png.toString("base64");
}
