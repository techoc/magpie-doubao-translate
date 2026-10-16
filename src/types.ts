// 跨模块共用的领域类型。
//
// 这里的类型描述的是「模块之间传递什么」，不含运行时逻辑，因此不会产生任何
// 打包体积。数据从外部输入（HTTP 请求、环境变量、宿主注入的登录凭据）进来时
// 一律先当作 unknown，由 schema 或显式校验收窄成这些类型。

// 三种对外兼容协议。
export type Protocol = "openai-chat" | "openai-responses" | "anthropic";

// fetch 的第一参数。@types/node 只把 RequestInit / Response 等声明为全局，
// 没有全局的 RequestInfo，因此这里显式写出来。
export type FetchInput = string | URL | Request;

// 适配层输出的「规范请求」：与协议无关，翻译核心只认这一种形状。
export interface CanonicalRequest {
    protocol: Protocol;
    model: string;
    targetLang: string;
    rawText: string;
    stream: boolean;
    scene: number;
    requestId: string;
}

// 适配层完整产出：canonical 给翻译编排，instructions / includeUsage 给响应格式化。
export interface AdaptedRequest {
    canonical: CanonicalRequest;
    instructions: string | null;
    includeUsage: boolean;
}

// 一次翻译的最终结果。
export interface TranslationResult {
    model: string;
    text: string;
    detectedLanguages: string[];
    upstreamBatchCount: number;
    elapsedMs: number;
}

// 协议响应负载：按协议分支动态拼字段（例如 usage 在三种协议下结构不同），
// 直接序列化成 JSON 返回，因此不逐字段建模，用宽松的 JSON 记录类型表达。
export type JsonPayload = Record<string, any>;

// 一次翻译的执行轨迹，用于用量统计与排障。
export interface TranslationTrace {
    upstreamCalls: number;
    retries: number;
    switches: number;
    queueMs: number;
}

// 可选的用量记录器；插件版不传，独立服务版用于统计。
export interface UsageRecorder {
    record(request: CanonicalRequest, elapsedMs: number, trace: TranslationTrace, code: string | undefined): void;
}

// 送上游的单批翻译请求。
export interface UpstreamTranslateRequest {
    texts: string[];
    targetLang: string;
    scene: number;
    engine: string;
}

// 上游返回的单批译文与检测到的语言。
export interface UpstreamTranslateResult {
    texts: string[];
    detectedLanguages: string[];
}

// 翻译编排依赖的客户端能力。
//
// 只用接口而不是具体的 DoubaoClient 类，编排逻辑就不必关心客户端怎么连上游，
// 也让单元测试能用极简的替身（只实现这两个方法）驱动重试与故障切换。
export interface TranslationClient {
    translate(req: UpstreamTranslateRequest, signal: AbortSignal, provider?: CookieProvider): Promise<UpstreamTranslateResult>;
    authStatus(signal: AbortSignal, provider?: CookieProvider): Promise<AuthStatus>;
}

// 解析后的登录 Cookie；complete 表示三个必需 Cookie 是否齐全。
export interface StoredCookie {
    cookie: string;
    complete: boolean;
}

// 取 Cookie 的回调。插件版由宿主登录凭据提供，服务版从账号池或文件读取。
export type CookieProvider = () => Promise<StoredCookie> | StoredCookie;

// 账号池租约：一次翻译期间固定使用某个账号。
export interface AccountLease {
    id: string;
    revision: string;
    provider: CookieProvider;
}

// 账号池接口。插件版不实现，独立服务版负责多账号与故障切换。
export interface AccountPool {
    choose(tried?: ReadonlySet<string>): Promise<AccountLease>;
    succeeded(id: string, revision: string): Promise<void>;
    failed(id: string, error: unknown, revision: string): Promise<void>;
    allowsFailover(): Promise<boolean>;
    list(): Promise<{activeId: string}>;
    getCookie(id: string): StoredCookie | undefined;
}

// 豆包客户端的登录状态检查结果。
export interface AuthStatus {
    authenticated: boolean;
    cookie_loaded: boolean;
    required_login_cookies_present: boolean;
    reason?: string;
    upstream_code?: number;
}

// ---------------------------------------------------------------------------
// 宿主（Magpie）接口。
//
// 宿主没有随包发布的类型声明，这里只声明本插件实际用到的部分：调用方传入的
// 一切仍然当作 unknown，由插件自身校验后再收窄，避免对宿主行为做过多假设。

// 宿主保存的登录凭据：type 固定为 api，key 即 Cookie 请求头。
export interface HostAuth {
    type: string;
    key?: string | undefined;
}

// 宿主写配置时传入的对象，插件把供应商注册进去。
export interface HostConfig {
    provider?: Record<string, HostProvider> | undefined;
}

// 供应商条目：字段沿用 OpenAI 兼容 SDK 的约定。
export interface HostProvider {
    name: string;
    npm: string;
    api: string;
    models: Record<string, HostModel>;
}

// 模型条目：声明上下文长度、是否支持工具调用等能力。
export interface HostModel {
    name: string;
    limit: {context: number; output: number};
    tool_call: boolean;
    reasoning: boolean;
    modalities: {input: string[]; output: string[]};
}

// 登录方式里的输入项；validate 返回 undefined 表示通过。
export interface HostPrompt {
    type: string;
    key: string;
    message: string;
    validate?: ((value: string) => string | undefined) | undefined;
}

// 登录流程最终拿到宿主要长期保存的凭据。
export interface HostLoginResult {
    type: "success";
    key: string;
    metadata: {email: string};
}

// 登录失败时把原因回给宿主展示。
export interface HostLoginFailure {
    type: "failed";
    error: string;
}

// 插件向宿主暴露的完整接口。
export interface MagpiePlugin {
    config(config: HostConfig): Promise<void>;
    auth: {
        provider: string;
        icon: string;
        maxConcurrency: number;
        methods: {
            type: string;
            label: string;
            prompts: HostPrompt[];
            authorize(inputs: Record<string, string> | undefined): Promise<{
                url: string;
                instructions: string;
                method: string;
                callback(): Promise<HostLoginResult | HostLoginFailure>;
            }>;
        }[];
        loader(getAuth: () => Promise<HostAuth>): Promise<{
            baseURL: string;
            apiKey: string;
            fetch(input: FetchInput, init?: RequestInit): Promise<Response>;
        }>;
    };
    provider: {
        id: string;
        models(provider: HostProvider, context?: {auth?: HostAuth | undefined}): Promise<Record<string, HostModel>>;
    };
}
