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
    constructor(code, status, message, retryable = false, param = null, upstreamCode, upstreamStatus) {
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
export const invalid = (message, code = "invalid_request", param = null) => new ServiceError(code, 400, message, false, param);
export function asServiceError(error) {
    return error instanceof ServiceError ? error : new ServiceError("internal_error", 500, "Internal service error.");
}
// 判断异常是否为 ServiceError，并在需要时收窄类型。
export function isServiceError(error) {
    return error instanceof ServiceError;
}
