export class RingBuffer<T> {
  private readonly items: T[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('RingBuffer capacity must be a positive integer');
    }
  }

  push(item: T): T | undefined {
    const evicted = this.items.length === this.capacity ? this.items.shift() : undefined;
    this.items.push(item);
    return evicted;
  }

  values(limit?: number): T[] {
    const selected = limit === undefined ? this.items : this.items.slice(-Math.max(0, limit));
    return [...selected];
  }

  get size(): number {
    return this.items.length;
  }
}
