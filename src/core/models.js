// 对外暴露的模型目录。
//
// 模型名只是对豆包 translate_service 参数的封装：同一个网页接口有三种翻译引擎，
// 用模型名区分，方便客户端按 OpenAI 习惯选择。
import { ServiceError } from "./errors.js";
// 模型 id -> 豆包 translate_service 取值（"1" 豆包 AI，"0" 火山，"3" 微软）。
export const MODEL_ENGINE_MAP = {
    "doubao-ai": "1",
    "volcengine-translate": "0",
    "microsoft-translator": "3"
};
// 按 OpenAI /v1/models 的形状输出；三个数组与 MODEL_ENGINE_MAP 的键顺序一一对应。
export const models = Object.keys(MODEL_ENGINE_MAP).map((modelId, i) => ({
    id: modelId,
    object: "model",
    created: 0,
    owned_by: ["doubao", "volcengine", "microsoft"][i] ?? "",
    type: "model",
    created_at: "1970-01-01T00:00:00Z",
    display_name: ["Doubao AI Translation", "Volcengine Translation", "Microsoft Translator"][i] ?? ""
}));
// 请求里的 model 必须是已知模型，否则返回 404 而不是 400。
export function resolveModel(value) {
    if (!Object.hasOwn(MODEL_ENGINE_MAP, value))
        throw new ServiceError("model_not_found", 404, "Model not found.", false, "model");
    return value;
}
