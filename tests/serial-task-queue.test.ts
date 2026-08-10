import { describe, expect, it } from "vitest";

import { SerialTaskQueue } from "../src/core/serial-task-queue";

describe("SerialTaskQueue", () => {
  it("does not let a later write finish ahead of an earlier write", async () => {
    const queue = new SerialTaskQueue();
    const events: string[] = [];
    let releaseFirst = (): void => undefined;
    let markStarted = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const first = queue.enqueue(async () => {
      events.push("first:start");
      markStarted();
      await firstGate;
      events.push("first:end");
    });
    const second = queue.enqueue(async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await started;
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("continues after a failed write", async () => {
    const queue = new SerialTaskQueue();
    await expect(queue.enqueue(async () => {
      throw new Error("write failed");
    })).rejects.toThrow("write failed");

    let completed = false;
    await queue.enqueue(async () => {
      completed = true;
    });
    expect(completed).toBe(true);
  });
});
