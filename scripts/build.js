// 构建脚本：把 src/ 打包成 dist/index.mjs。用法：npm run build
//
// 由 Bun 完成打包与类型擦除，产物是单个 ESM 文件；本脚本自己不依赖 Bun 的类型定义。
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
// 以脚本所在位置定位仓库根目录，不受调用时的工作目录影响。
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entry = path.join(root, "src/index.js");
const outfile = path.join(root, "dist/index.mjs");
// 首次编译产物缓存无效时也仍然按入口扩展名解析，因此这里无需额外配置。
// 给产物加头部注释，避免有人误改生成的文件；同时说明图标路径的约束。
const BANNER_MARK = "// 由 scripts/build.js 从 src/ 生成";
const banner = `${BANNER_MARK}，请勿手工修改。
// 图标在运行时从 ../assets/icon-magpie.png 读取，
// 因此本文件必须保持在包根目录下一层。
`;
function run(command, args) {
    try {
        execFileSync(command, args, { cwd: root, stdio: "inherit" });
    }
    catch (error) {
        // 缺少 Bun 时给出明确提示，而不是抛出晦涩的 spawn 错误。
        if (error.code === "ENOENT") {
            console.error(`\n${command} was not found. Install Bun (https://bun.sh) to build the plugin.`);
            process.exit(1);
        }
        throw error;
    }
}
run("bun", ["build", entry, "--outfile", outfile, "--target", "node", "--format", "esm"]);
// 重复构建时避免叠加头部注释。
const bundle = await readFile(outfile, "utf8");
if (!bundle.startsWith(BANNER_MARK)) {
    await writeFile(outfile, banner + bundle);
}
console.log(`\nWrote ${path.relative(root, outfile)}`);
