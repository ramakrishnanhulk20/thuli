/** Paid requests in flight at once, from the payment check to the reply. Each can run one screening. */
export const MAX_RUNNING = 4;
/** Screenings started in one UTC day by this process, counting the ones already in flight. */
export const MAX_PER_DAY = 600;

/** One paid request's place. started turns true when its screening begins, so the day counts it once. */
export interface Ticket {
  started: boolean;
}

/**
 * The global ceiling on paid screenings (threat model C24, C42). It counts nothing the caller sends, no address and no
 * forwarded-for header, so a caller cannot get a fresh allowance by changing what it claims to be. It limits this one
 * process; several processes each get their own allowance.
 */
export class ScreenGuard {
  readonly #now: () => Date;
  #day = '';
  #startedToday = 0;
  #running = 0;
  #waiting = 0;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  #roll(): void {
    const day = this.#now().toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#startedToday = 0;
    }
  }

  /** True when one more paid request could break either ceiling, so the caller must answer busy before asking for payment. */
  busy(): boolean {
    this.#roll();
    return this.#running >= MAX_RUNNING || this.#startedToday + this.#waiting >= MAX_PER_DAY;
  }

  /** Takes a place for a paid request. Call only after busy() said false, and always pair it with leave(). */
  enter(): Ticket {
    this.#running += 1;
    this.#waiting += 1;
    return { started: false };
  }

  /** The screening for this ticket begins. Counted once toward today, however long it runs. */
  start(ticket: Ticket): void {
    if (ticket.started) return;
    this.#roll();
    ticket.started = true;
    this.#waiting -= 1;
    this.#startedToday += 1;
  }

  leave(ticket: Ticket): void {
    this.#running -= 1;
    if (!ticket.started) this.#waiting -= 1;
  }
}
