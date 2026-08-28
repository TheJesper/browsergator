export class PerTabFifo {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly depths = new Map<string, number>();

  async enqueue<T>(pageId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(pageId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(pageId, tail);
    this.depths.set(pageId, (this.depths.get(pageId) ?? 0) + 1);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      const depth = (this.depths.get(pageId) ?? 1) - 1;
      if (depth <= 0) this.depths.delete(pageId);
      else this.depths.set(pageId, depth);
      if (this.tails.get(pageId) === tail) this.tails.delete(pageId);
    }
  }

  depth(pageId: string): number {
    return this.depths.get(pageId) ?? 0;
  }
}
