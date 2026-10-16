// 极简 SSE 解析器。
//
// 只支持豆包侧用到的子集：增量 UTF-8 解码、CRLF / CR / LF 换行、
// event 与 data 字段。空行代表一个事件结束，触发 emit 回调。
export class SSEParser {
    constructor(emit) {
        // stream 模式解码，跨 chunk 的多字节字符会被正确拼接。
        this.decoder = new TextDecoder();
        // 尚未构成完整行的残留文本。
        this.buffer = "";
        this.event = "message";
        this.data = [];
        this.emit = emit;
    }
    push(bytes) {
        this.consume(this.decoder.decode(bytes, { stream: true }), false);
    }
    // 数据流结束时调用，冲刷解码器缓存并派发最后一个事件。
    finish() {
        this.consume(this.decoder.decode(), true);
    }
    consume(text, final) {
        this.buffer += text;
        let start = 0;
        for (let i = 0; i < this.buffer.length; i++) {
            const char = this.buffer[i];
            if (char !== "\n" && char !== "\r")
                continue;
            // 末尾的孤立 \r 可能只是 CRLF 被拆到两个 chunk，先等下一个 chunk。
            if (char === "\r" && i === this.buffer.length - 1 && !final)
                break;
            this.line(this.buffer.slice(start, i));
            // \r\n 视为一个换行，跳过 \n。
            if (char === "\r" && this.buffer[i + 1] === "\n")
                i++;
            start = i + 1;
        }
        this.buffer = this.buffer.slice(start);
        if (this.buffer.length > 8 * 1024 * 1024)
            throw new Error("SSE line limit exceeded.");
        if (final) {
            // 流结束时最后一行可能没有换行符收尾。
            if (this.buffer)
                this.line(this.buffer);
            this.buffer = "";
            this.dispatch();
        }
    }
    // 解析单行：SSE 允许 "field" 或 "field: value" 两种写法。
    line(line) {
        // 空行表示事件边界。
        if (!line) {
            this.dispatch();
            return;
        }
        // 冒号开头是注释（常用作心跳），忽略。
        if (line.startsWith(":"))
            return;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        // 规范要求冒号后最多去掉一个前导空格。
        if (value.startsWith(" "))
            value = value.slice(1);
        if (field === "event")
            this.event = value;
        // 多行 data 按换行拼接。
        if (field === "data")
            this.data.push(value);
    }
    dispatch() {
        // 无 data 且事件名为默认值时不派发，避免发出空事件。
        if (this.data.length || this.event !== "message")
            this.emit({ event: this.event, data: this.data.join("\n") });
        this.data = [];
        this.event = "message";
    }
}
