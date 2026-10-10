// In-process job queues with a concurrency cap per lane. Compiles are CPU-bound and
// Claude calls are rate-limited, so each gets its own lane. Requests await their job
// and keep streaming progress, so the HTTP layer doesn't change. Swap this for a
// Redis/Postgres-backed queue with separate worker processes when scaling out.
class Lane {
  constructor(name, concurrency) {
    this.name = name;
    this.concurrency = concurrency;
    this.running = 0;
    this.waiting = [];
  }

  run(fn, onQueued) {
    return new Promise((resolve, reject) => {
      const start = () => {
        this.running++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            this.waiting.shift()?.();
          });
      };
      if (this.running < this.concurrency) start();
      else {
        onQueued?.(this.waiting.length + 1);
        this.waiting.push(start);
      }
    });
  }

  get stats() {
    return { running: this.running, waiting: this.waiting.length };
  }
}

export const compileLane = new Lane("compile", Number(process.env.COMPILE_CONCURRENCY) || 2);
export const claudeLane = new Lane("claude", Number(process.env.CLAUDE_CONCURRENCY) || 2);

export const queueStats = () => ({ compile: compileLane.stats, claude: claudeLane.stats });
