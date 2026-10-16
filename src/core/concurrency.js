// 带排队的并发闸门。
//
// 同时约束三件事：并发上限、排队长度上限、排队等待上限。超出排队长度立刻失败，
// 等待超时或请求中断则从队列中摘除，避免请求堆积拖垮上游。
import { ServiceError } from "./errors.js";
export class Semaphore {
    constructor(limit, maxQueue, timeout) {
        this.active = 0;
        this.queue = [];
        this.limit = limit;
        this.maxQueue = maxQueue;
        this.timeout = timeout;
    }
    get status() {
        return { active: this.active, queued: this.queue.length, limit: this.limit, maxQueue: this.maxQueue };
    }
    // 成功时返回 release 函数；调用方必须在 finally 里执行一次释放。
    async acquire(signal) {
        signal.throwIfAborted();
        // 仍有并发额度：直接进入，不计入排队。
        if (this.active < this.limit) {
            this.active++;
            return this.releaseOnce();
        }
        if (this.queue.length >= this.maxQueue)
            throw new ServiceError("queue_full", 429, "Upstream queue is full.");
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", abort);
            };
            const remove = () => {
                const i = this.queue.indexOf(waiter);
                if (i >= 0)
                    this.queue.splice(i, 1);
            };
            const waiter = {
                // 被前一个请求释放时唤起：此时已经占用了一个并发额度。
                grant: () => {
                    cleanup();
                    this.active++;
                    resolve(this.releaseOnce());
                },
                fail: (error) => {
                    cleanup();
                    remove();
                    reject(error);
                }
            };
            const abort = () => waiter.fail(signal.reason);
            const timer = setTimeout(() => waiter.fail(new ServiceError("queue_timeout", 503, "Upstream queue wait timed out.")), this.timeout);
            this.queue.push(waiter);
            signal.addEventListener("abort", abort, { once: true });
        });
    }
    // 只允许释放一次：重复调用（例如并发路径里多次 finally）不会多放行请求。
    releaseOnce() {
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.active--;
            // 让出额度给队首等待者，队首会自行递增 active。
            this.queue.shift()?.grant();
        };
    }
}
