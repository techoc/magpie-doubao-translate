// src/vendor/zod.js 的类型声明（手写子集）。
//
// zod.js 是从上游 zod 包重新生成的打包产物（约 2 万行，见该文件头部说明），
// 不随本仓库源码维护，因此不为它补全类型，只为 schema 用到的 API 声明签名。
//
// 声明目标是「输出类型可推导」，而不是完整复刻 Zod：
//   z.object({...}).safeParse(value).data  能推出每个字段的类型；
//   z.string().default("x")                输入可省略、输出仍是 string。
// 未用到的 API（union、record、map、promise 等）不在范围内，用到时再补。

export type ZodOutput<Type> = Type extends ZodType<infer Output, infer _Input> ? Output : never;

export interface ZodIssue {
    path: (string | number | symbol)[];
    message: string;
}

// safeParse 的返回值：成功带 data，失败带 issues（调用方用 path 拼出出错字段）。
export type ZodSafeParseResult<Output> =
    | {success: true; data: Output}
    | {success: false; error: {issues: ZodIssue[]}};

export interface ZodType<Output = unknown, Input = Output> {
    parse(value: unknown): Output;
    safeParse(value: unknown): ZodSafeParseResult<Output>;
    // 允许 undefined 通过，输出类型随之带上 undefined。
    optional(): ZodType<Output | undefined, Input | undefined>;
    // 输入缺失时填入默认值，因此输出类型不变、输入变成可省略。
    default(value: Output): ZodType<Output, Input | undefined>;
    // 附加校验：不改变类型，只可能让解析失败。
    refine(check: (value: Output) => unknown, message?: string): ZodType<Output, Input>;
    // 校验后的值会被改写，输出类型以映射结果为准。
    transform<Next>(map: (value: Output) => Next): ZodType<Next, Input>;
    // 把输出接到另一个 schema 上，输出类型取自后者。
    pipe<Next extends ZodType>(next: Next): ZodType<ZodOutput<Next>, Input>;
}

export interface ZodString extends ZodType<string, string> {
    min(length: number, message?: string): ZodString;
    max(length: number, message?: string): ZodString;
}

export interface ZodNumber extends ZodType<number, number> {
    int(): ZodNumber;
    positive(): ZodNumber;
    min(value: number, message?: string): ZodNumber;
    max(value: number, message?: string): ZodNumber;
}

export type ZodBoolean = ZodType<boolean, boolean>;

export interface ZodArray<Item> extends ZodType<Item[], Item[]> {
    min(length: number, message?: string): ZodArray<Item>;
    max(length: number, message?: string): ZodArray<Item>;
}

// 对象的字段形状：键为字段名，值为该字段的 schema。
export interface ZodRawShape {
    [key: string]: ZodType;
}

export type ZodObjectOutput<Shape extends ZodRawShape> = {
    [Key in keyof Shape]: ZodOutput<Shape[Key]>;
};

export interface ZodObject<Shape extends ZodRawShape = ZodRawShape> extends ZodType<ZodObjectOutput<Shape>> {
    // 拒绝未声明的字段（插件选项用它挡住拼写错误）。
    strict(): ZodObject<Shape>;
    // 保留未声明字段，交给后续的能力检查逐项判断。
    passthrough(): ZodObject<Shape>;
}

// zod 命名空间（本仓库统一以 `z` 使用）。
export interface ZodNamespace {
    string(): ZodString;
    number(): ZodNumber;
    boolean(): ZodBoolean;
    unknown(): ZodType<unknown, unknown>;
    url(): ZodString;
    literal<Value extends string | number | boolean>(value: Value): ZodType<Value, Value>;
    enum<Values extends readonly string[]>(values: Values): ZodType<Values[number], Values[number]>;
    object<Shape extends ZodRawShape>(shape: Shape): ZodObject<Shape>;
    array<Item extends ZodType>(item: Item): ZodArray<ZodOutput<Item>>;
    // 先把原始输入归一（例如把环境变量的空白串转成 undefined），再交给内层 schema。
    preprocess<Schema extends ZodType>(map: (value: unknown) => unknown, schema: Schema): ZodType<ZodOutput<Schema>>;
    readonly coerce: {
        number(): ZodNumber;
        string(): ZodString;
        boolean(): ZodBoolean;
    };
}

export declare const external_exports: ZodNamespace;
