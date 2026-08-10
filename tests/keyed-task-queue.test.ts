import { describe, expect, it } from "vitest";

import { KeyedTaskQueue } from "../src/core/keyed-task-queue";

describe("KeyedTaskQueue", () => {
  it("serializes mutations for the same note", async () => {
    const queue = new KeyedTaskQueue();
    const events: string[] = [];
    let releaseFirst = (): void => undefined;
    let markStarted = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const first = queue.run("A.md", async () => {
      events.push("first:start");
      markStarted();
      await gate;
      events.push("first:end");
    });
    const second = queue.run("A.md", async () => {
      events.push("second:start");
    });

    await started;
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("allows different notes to mutate independently", async () => {
    const queue = new KeyedTaskQueue();
    const events: string[] = [];
    let releaseA = (): void => undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const a = queue.run("A.md", async () => await gateA);
    const b = queue.run("B.md", async () => {
      events.push("B");
    });
    await b;
    expect(events).toEqual(["B"]);
    releaseA();
    await a;
  });
});
