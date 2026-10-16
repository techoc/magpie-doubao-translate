// 全项目共用的错误类型。
//
// ServiceError 同时承载两类信息：
//   code / status / retryable / param  本服务返回给客户端的错误码、HTTP 状态、
//                                      是否可重试、触发错误的请求参数名
//   upstreamCode / upstreamStatus      豆包侧的业务码与 HTTP 状态，用于判断登录
//                                      是否失效，以及把上游 429 原样透传
// signIn                              标记「需要重新登录」，宿主据此引导用户
// invalid()       构造「调用方错误」的简写（400、不可重试）
// asServiceError() 把任意异常收敛为 ServiceError，避免非本类型异常泄漏到响应里

// 上游业务码与 HTTP 状态在未涉及上游错误时为 undefined。
export class ServiceError extends Error {
    readonly code: string;
    readonly status: number;
    readonly retryable: boolean;
    readonly param: string | null;
    readonly upstreamCode: number | undefined;
    readonly upstreamStatus: number | undefined;
    // 仅在登录失效时设置，取值固定为 "expired"。
    // 用 declare 声明：这类可选标记只在需要时动态挂上，不进入对象形状，
    // 保证错误对象序列化后与之前的版本完全一致。
    declare signIn?: "expired";

    constructor(
        code: string,
        status: number,
        message: string,
        retryable = false,
        param: string | null = null,
        upstreamCode?: number,
        upstreamStatus?: number
    ) {
        super(message);
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.param = param;
        this.upstreamCode = upstreamCode;
        this.upstreamStatus = upstreamStatus;
    }
}

// 参数校验、能力不支持等由调用方引起的问题统一走这里。
export const invalid = (message: string, code = "invalid_request", param: string | null = null): ServiceError =>
    new ServiceError(code, 400, message, false, param);

export function asServiceError(error: unknown): ServiceError {
    return error instanceof ServiceError ? error : new ServiceError("internal_error", 500, "Internal service error.");
}

// 判断异常是否为 ServiceError，并在需要时收窄类型。
export function isServiceError(error: unknown): error is ServiceError {
    return error instanceof ServiceError;
}
