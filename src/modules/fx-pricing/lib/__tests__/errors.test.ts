import { describe, expect, it } from "vitest";
import { describeError, formatError } from "../errors";

describe("describeError", () => {
  it("keeps message, name and stack from a real Error", () => {
    const error = new TypeError("nope");
    const described = describeError(error);
    expect(described.message).toBe("nope");
    expect(described.name).toBe("TypeError");
    expect(described.stack).toContain("TypeError: nope");
  });

  /**
   * The regression this whole module exists for. Medusa's
   * `TransactionOrchestrator` stores a failed step's error as
   * `serializeError(error)` - a PLAIN OBJECT, not an `Error` - and
   * `workflow-export` then throws that object. `String()` renders it as
   * "[object Object]", which is what production recorded on 2026-08-27 and all
   * anyone has of that failure.
   */
  it("reads the message off Medusa's serialized (non-Error) workflow error", () => {
    const serialized = {
      message: "Cannot create multiple links between 'productService' and 'pricingService'",
      name: "MedusaError",
      stack: "MedusaError: Cannot create multiple links\n    at RemoteLink.create",
      type: "invalid_data",
    };
    const described = describeError(serialized);
    expect(described.message).toBe(
      "Cannot create multiple links between 'productService' and 'pricingService'",
    );
    expect(described.name).toBe("MedusaError");
    expect(described.stack).toContain("RemoteLink.create");
    expect(String(serialized)).toBe("[object Object]"); // what the old code produced
  });

  it("unwraps the orchestrator's { action, handlerType, error } record and names the failing step", () => {
    const described = describeError({
      action: "create-variant-pricing-link",
      error: { message: "Cannot create multiple links", name: "MedusaError" },
      handlerType: "invoke",
    });
    expect(described.message).toBe(
      "create-variant-pricing-link (invoke): Cannot create multiple links",
    );
    expect(described.name).toBe("MedusaError");
  });

  it("takes the first of a list of errors and says how many more there were", () => {
    const described = describeError([
      { action: "step-a", error: { message: "first" } },
      { action: "step-b", error: { message: "second" } },
    ]);
    expect(described.message).toBe("step-a: first (and 1 more)");
  });

  it("follows a cause chain", () => {
    const described = describeError({ cause: { message: "the real reason" } });
    expect(described.message).toBe("the real reason");
  });

  it("passes a thrown string through", () => {
    expect(describeError("plain failure").message).toBe("plain failure");
  });

  it("falls back to JSON, never to [object Object]", () => {
    const described = describeError({ code: "ECONNRESET", port: 5432 });
    expect(described.message).toBe('{"code":"ECONNRESET","port":5432}');
    expect(described.message).not.toBe("[object Object]");
  });

  it("survives a circular object instead of throwing", () => {
    const circular: Record<string, unknown> = { code: "loop" };
    circular.self = circular;
    expect(describeError(circular).message).toContain("loop");
  });

  it("says something useful about a thrown null or undefined", () => {
    expect(describeError(null).message).not.toBe("");
    expect(describeError(undefined).message).not.toBe("");
    expect(describeError(null).message).not.toBe("[object Object]");
  });
});

describe("formatError", () => {
  it("prefixes the name when it adds information", () => {
    expect(formatError({ message: "boom", name: "MedusaError" })).toBe("MedusaError: boom");
  });

  it("does not prefix a bare Error", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });

  it("does not repeat a name the message already starts with", () => {
    expect(formatError({ message: "MedusaError: boom", name: "MedusaError" })).toBe(
      "MedusaError: boom",
    );
  });
});
