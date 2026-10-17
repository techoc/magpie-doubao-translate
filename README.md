# Magpie Doubao Translate

[简体中文](README.md) | [English](README.en.md)

直接使用本人或已获授权的豆包 Cookie 翻译文本，无须部署 doubao-translate2api 服务、Docker 或额外 API Key。

## 免责声明

本项目是独立的非官方实现，与豆包、Magpie 及其他相关平台不存在隶属或合作关系，也不代表获得其授权、认可或背书。相关名称与商标属于各自权利人。

本项目旨在供学习、研究和开发交流。使用者应自行确认并遵守适用法律法规、相关平台的服务条款及账号使用规则，仅使用本人拥有或已获合法授权的账号与 Cookie，不得用于违法活动或侵害他人权益。

Cookie 属于敏感登录凭证，请妥善保管，不要公开、提交到仓库或分享包含 Cookie 的 `plugin-auth.json`。翻译文本会发送至豆包及其相关翻译服务，提交前请自行确认有权处理该内容，并评估隐私与保密要求。

软件按 [MIT 许可证](LICENSE)以“现状”提供，不保证接口持续可用、翻译准确、账号安全或适用于特定用途。网页接口变更、账号风控或封禁、Cookie 泄露、服务中断、翻译错误及其他使用风险，均由使用者自行评估并承担；重要内容应由使用者核验翻译结果。

在适用法律允许的范围内，作者和贡献者不对使用或无法使用本项目产生的损失、索赔或其他责任负责。下载、安装或使用前，请阅读本声明及 [MIT 许可证](LICENSE)；如无法接受相关风险，请勿使用。

## 合规风险说明

本插件使用 Cookie 自动调用豆包网页翻译接口，不是官方开放 API。本项目未取得或核实平台对此调用方式的专项授权，也不保证这种使用方式符合平台当前的服务条款。以下说明列出需要核实的风险，不表示平台已明确禁止所有此类调用，也不构成对具体使用场景的合法性认定。

- **账号授权不等于接口使用授权。** 即使使用本人账号或已获账号持有人许可的 Cookie，也不代表平台允许自动化访问、批量调用、将网页服务封装为 API 或向第三方提供服务。使用前应核实平台当前关于自动化访问、凭证共享及服务转供的规定。
- **个人使用和学习研究不自动免除责任。** 免费、开源、低频或仅供个人使用，均不能作为符合服务条款或适用法律的保证。若调用方式不被平台允许，可能面临访问限制、账号停用、服务终止，以及视具体情况产生的合同争议或其他责任。
- **不要绕过平台限制。** 不应利用本项目绕过验证码、访问控制、付费限制、限流或账号处罚，也不应使用未经授权获取的 Cookie。平台拒绝访问或提出停止要求时，应停止相关调用。
- **处理文本前需确认权限。** 提交的原文会发送至豆包及其相关翻译服务。涉及他人个人信息、客户资料、公司机密或受版权保护的内容时，应确认具备必要的处理与提交权限，并核实适用的隐私、保密、版权和数据传输要求；将 Cookie 导入远端 Magpie 也应获得相应的凭证保管授权。
- **商业使用或对外服务需要单独评估。** 将本插件用于收费服务、企业业务或向第三方开放翻译能力前，应核实平台是否允许该用途，并评估授权、数据处理和合同要求。MIT 许可证仅授予本项目代码的使用权限，不授予豆包服务、账号、接口或相关内容的使用权。

本项目的免责声明和 MIT 许可证不能替代平台授权，也不能免除适用法律规定的责任。对合规要求较高的业务，建议选择明确授权该用途的官方 API 或服务，并按实际使用场景取得必要许可。

## 项目入口

| 入口 | 用途 |
| --- | --- |
| [Magpie 直连插件](https://github.com/mu-zi-lee/magpie-doubao-translate) | 当前插件的发布仓库，可由本机或远端 Magpie 直接安装 |
| [API 服务源码与部署文档](https://github.com/mu-zi-lee/doubao-translate2api) | 在 NAS 或服务器部署，向多个翻译客户端提供兼容 API |
| [Docker Hub 镜像](https://hub.docker.com/r/muzileee/doubao-translate2api) | 拉取 `muzileee/doubao-translate2api` 部署 API 服务 |

服务版和插件版共用翻译核心，可按使用场景选择。只在 Magpie 中翻译时安装本插件即可；需要管理页、Cookie 池、API Key 或为多个客户端提供服务时，使用 API 服务或 Docker 镜像。

## 直接安装（远端也适用）

在 Magpie「插件 → 发现」底部的安装框填写：

```text
github:mu-zi-lee/magpie-doubao-translate
```

点击安装，再进入「已安装」或「供应商」，选择 **Doubao Translation** 的 **Import Doubao Cookie** 登录。
也可以在运行 Magpie 的机器上使用 CLI：

```sh
magpie plugin add github:mu-zi-lee/magpie-doubao-translate
magpie plugin login doubao-translate
```

GitHub 发布仓库包含已构建的插件和运行时依赖，无须 Node.js 开发环境、Docker 或额外构建步骤。
固定版本时填写 `github:mu-zi-lee/magpie-doubao-translate#v0.1.2`。
更新时在 Magpie 中更新插件，或运行 `magpie plugin update`。

v0.1.1 随插件打包头像图标，安装或更新后，支持自定义插件图标的 Magpie 会在供应商列表显示。图标通过 `auth.icon` 内嵌提供，本机和远端安装均无须另行下载图片；若更新后仍显示默认图标，可关闭再开启插件或重启 Magpie。

v0.1.2 更新为新的头像图标，并提供无损压缩的 PNG，保留原图尺寸和像素内容。

## 从源码构建

源码按模块拆分为 `src/`，全部使用 TypeScript，`dist/index.mjs` 由构建脚本打包生成，请勿手工修改。
构建需要 Bun；类型检查需要 Node.js 与 `npm install` 安装的开发依赖（TypeScript、Zod）。
Zod 只在构建时使用，打包器会把它内联进 `dist/index.mjs`，因此发布包依旧零依赖。
Node.js 22.18+ 与 Bun 都能直接运行 `.ts`，因此测试不需要预编译步骤：

```sh
npm install
npm run typecheck
npm run build
npm test
magpie plugin add .
magpie plugin login doubao-translate
```

也可以在 Magpie 的「插件 → 添加插件」填写本仓库根目录的绝对路径。
插件包已包含运行时依赖，无安装脚本。

可用脚本：

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | 用 `tsc` 做完整类型检查（不产出文件） |
| `npm run typecheck:watch` | 监听模式类型检查，开发时常驻 |
| `npm test` | 运行全部单元测试与协议行为测试 |
| `npm test:watch` | 监听模式跑测试 |
| `npm run build` | 用 Bun 打包出 `dist/index.mjs` |
| `npm run verify` | 依次执行类型检查、测试、打包，提交前跑一遍 |

`.github/workflows/ci.yml` 会在推送与 PR 上执行同样的检查，并额外校验
`dist/index.mjs` 与 `src/` 保持同步（改了源码忘记重新构建会让 CI 失败）。

登录时粘贴完整 Cookie Header 或浏览器导出的 Cookie JSON，可填写账号名称。
必须包含 `sessionid`、`sid_tt` 和 `uid_tt`，登录时会请求豆包检测有效性。
每次登录可添加一个账号，调度与故障切换交给 Magpie。
登录信息保存在 Magpie 配置目录的 `plugin-auth.json`（权限 600），包括规范化 Cookie 和账号名称；请勿分享此文件。
插件使用自定义导入流程，检测成功后保存 Cookie，不需要额外填写 API Key 或打开登录浏览器。
Cookie 过期需要重新导入，不提供自动登录或续期。

## 模型与翻译

| 模型 | 引擎 |
| --- | --- |
| `doubao-translate/doubao-ai` | 豆包 AI 翻译 |
| `doubao-translate/volcengine-translate` | 火山翻译 |
| `doubao-translate/microsoft-translator` | 微软翻译 |

三者都通过豆包网页接口调用。供应商使用 Chat Completions，Magpie 负责转换客户端协议。
默认目标语言为简体中文。请求的 `target_lang`、`X-Doubao-Target-Lang` 或明确翻译指令优先于插件默认值。
只翻译最后一条 user 文本，不支持对话记忆、图片、工具、推理或结构化输出。
在翻译客户端显式选择上述模型，避免将其用于聊天、编程或自动路由的通用任务。
模型的 32000 token 输入/输出预算是保守的网关配置，不代表上游额度或精确的字符限制。

长文本自动分段并按原顺序还原换行；全部成功后才返回结果。
流式请求在完整翻译成功后输出 SSE，不是逐 token 实时翻译。
豆包网页接口不返回 token 用量，插件按文本估算：约四个 ASCII 字符一个 token，其余字符（主要为 CJK）一个字符一个 token。
估算值用于输入/输出 token 展示与统计，不是上游真实计数，也不代表上游套餐额度。
插件不保存原文、译文或独立统计文件。

## 选项

在 Magpie 的插件配置 `options` 中设置，或使用 CLI：

```sh
magpie plugin options magpie-doubao-translate '{"targetLang":"en","maxConcurrency":4}'
```

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `targetLang` | `"zh"` | 默认目标语言 |
| `scene` | `2` | 豆包翻译场景，1–6 |
| `maxConcurrency` | `4` | 插件上游总并发及 Magpie 每账号建议上限，1–1000 |
| `requestTimeoutMs` | `45000` | 单次上游请求超时 |
| `totalTimeoutMs` | `180000` | 包含排队、分段与重试的总超时 |
| `authTimeoutMs` | `10000` | 登录检测超时 |
| `maxRetries` | `0` | 单批临时故障重试，0–10；默认交给 Magpie 故障切换 |
| `queueMax` | `100` | 插件内部最大排队数 |
| `queueTimeoutMs` | `30000` | 排队超时 |

修改后关闭再开启插件，使供应商选项重新加载。
插件不读取独立服务的 `.env`、Cookie 文件或账号池。
豆包登录失效返回 `X-Magpie-Sign-In: expired`；HTTP 429 保留为 429，其他失败使用兼容 API 错误格式。
网络或服务临时故障不会标记登录过期。代理使用 Magpie 的账号/供应商代理配置。

## 检测与打包

```sh
magpie provider test doubao-translate doubao-ai
```

该命令验证连通性，翻译验收还应明确发送目标语言和原文。
开发检查在本仓库运行 `npm test` 和 `npm run build`。
本地 mock 和 Bun 加载检查不代表真实 Magpie、Cookie 或豆包翻译验收。
官方 Magpie Bun 插件宿主的模拟上游检查已覆盖加载、Cookie 登录保存和流式返回；真实豆包与远端客户端仍需验收。
插件打包了 Zod，其 MIT 许可证在 `THIRD_PARTY_LICENSES.txt`。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| `src/magpie/plugin.ts` | Magpie 插件入口：供应商注册、Cookie 登录、请求分发 |
| `src/types.ts` | 跨模块共用的领域类型与宿主接口 |
| `src/protocols/` | 三种协议的请求适配与响应格式化 |
| `src/doubao/` | 豆包网页接口客户端、SSE 解析、语言表 |
| `src/core/` | 错误类型、并发闸门、分段、翻译编排、提示词解析 |
| `src/auth/`、`src/admin/` | Cookie 解析与导入、账号失败分类 |
| `src/config/` | 环境变量 schema（插件以自身选项填充） |
| `tests/plugin.test.ts` | 端到端协议行为测试（模拟豆包上游驱动 loader.fetch） |
| `tests/{core,prompt,cookie,protocols,doubao,config,translator}.test.ts` | 各模块单元测试（切分、语言、Cookie、协议适配、上游客户端、配置、编排重试） |
| `scripts/build.ts` | 用 Bun 把 `src/` 打包成 `dist/index.mjs` |

构建后可以创建独立 npm 包，无须运行安装脚本：

```sh
npm pack
```

当前通过 GitHub 发布仓库安装，未发布到 npm 或插件推荐市场。
