const queue = [];
let running = 0;

const maxConcurrency = Math.max(1, Number(process.env.AI_REVIEW_CONCURRENCY || 2));

const pump = () => {
    while (running < maxConcurrency && queue.length) {
        const job = queue.shift();
        running += 1;
        Promise.resolve()
            .then(job)
            .catch((err) => {
                // Jobs should handle their own errors; this is a final safeguard.
                console.error("[AI Reviews] Unhandled job error:", err);
            })
            .finally(() => {
                running -= 1;
                // Avoid deep sync recursion if jobs enqueue more jobs.
                setImmediate(pump);
            });
    }
};

export const enqueueJob = (fn) => {
    queue.push(fn);
    setImmediate(pump);
};

export const getQueueStats = () => ({
    running,
    queued: queue.length,
    maxConcurrency,
});

