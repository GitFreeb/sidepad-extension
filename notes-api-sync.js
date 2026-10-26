// Опрос server-backed вкладки: только при видимой панели, без параллельных
// запросов, с ограниченным backoff при офлайне/429/503.
export const POLL_INTERVAL_MS = 2000;
export const MAX_BACKOFF_MS = 60000;

export function backoffDelay(failures) {
  return Math.min(POLL_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS);
}

export class VisiblePoller {
  // tick() возвращает 'ok' или 'backoff'; исключение считается неудачей.
  // Обёртки обязательны: setTimeout, вызванный как метод объекта, в браузере
  // бросает Illegal invocation.
  constructor({ tick, isVisible, schedule = (fn, delay) => setTimeout(fn, delay), cancel = (timer) => clearTimeout(timer) }) {
    this.tick = tick;
    this.isVisible = isVisible;
    this.schedule = schedule;
    this.cancel = cancel;
    this.running = false;
    this.inFlight = false;
    this.failures = 0;
    this.timer = null;
    this.generation = 0;
  }

  start() {
    this.running = true;
    this.wake();
  }

  stop() {
    this.running = false;
    this.generation += 1;
    this.inFlight = false;
    this.clearTimer();
  }

  wake() {
    if (!this.running || this.inFlight) return;
    this.clearTimer();
    if (this.isVisible()) this.run();
    else this.recheckLater();
  }

  // Скрытая панель не ходит в сеть; таймер лишь перепроверяет видимость,
  // чтобы не зависеть от того, придёт ли visibilitychange.
  recheckLater() {
    this.timer = this.schedule(() => {
      this.timer = null;
      return this.wake();
    }, POLL_INTERVAL_MS);
  }

  clearTimer() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }

  async run() {
    const generation = this.generation;
    this.inFlight = true;
    let result;
    try {
      result = await this.tick();
    } catch {
      result = 'backoff';
    }
    if (generation !== this.generation) return;
    this.inFlight = false;
    this.failures = result === 'backoff' ? this.failures + 1 : 0;
    if (!this.running) return;
    this.clearTimer();
    if (!this.isVisible()) {
      this.recheckLater();
      return;
    }
    this.timer = this.schedule(() => {
      this.timer = null;
      return this.wake();
    }, backoffDelay(this.failures));
  }
}
