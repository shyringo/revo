import test from "node:test";
import assert from "node:assert/strict";
import { Kernel } from "../src/core/kernel.js";

test("kernel mounts services and disposes in reverse order", async () => {
  const kernel = new Kernel();
  const order = [];
  await kernel.use({ name: "one", mount(ctx) { ctx.provide("answer", 42); return () => order.push("one"); } });
  await kernel.use({ name: "two", mount() { return () => order.push("two"); } });
  assert.equal(kernel.service("answer"), 42);
  assert.deepEqual(kernel.plugins(), ["one", "two"]);
  await kernel.close();
  assert.deepEqual(order, ["two", "one"]);
});
