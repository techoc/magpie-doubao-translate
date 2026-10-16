// 测试公用小工具。
//
// assert.throws / assert.rejects 的断言回调收到的 error 在类型上是 unknown，
// 每个用例都要写一遍 instanceof 判断会很啰嗦，这里统一收窄成 ServiceError。
import { ServiceError } from "../src/core/errors.js";
// 断言传入的确实是 ServiceError 并返回带类型的错误对象。
export function serviceError(error) {
    if (!(error instanceof ServiceError))
        throw new Error(`期望抛出 ServiceError，实际是 ${String(error)}`);
    return error;
}
// 断言错误的错误码（可选再断言 HTTP 状态），用于 assert.throws 的判定回调。
export function failedWith(code, status) {
    return (error) => {
        const value = serviceError(error);
        return value.code === code && (status === undefined || value.status === status);
    };
}
// 同上，并额外断言触发错误的请求参数名（param 是给客户端看的关键信息）。
export function failedWithParam(code, param, status) {
    return (error) => {
        const value = serviceError(error);
        return value.code === code && value.param === param && (status === undefined || value.status === status);
    };
}
// 按下标取数组元素（支持倒数下标，语义同 Array.prototype.at）。
// 越界时直接抛错：既满足 noUncheckedIndexedAccess，也让「这里应该有元素」
// 的意图显式写在测试里。
export function at(items, index) {
    const value = index < 0 ? items[items.length + index] : items[index];
    if (value === undefined)
        throw new Error(`期望数组下标 ${index} 有元素，实际长度为 ${items.length}`);
    return value;
}
