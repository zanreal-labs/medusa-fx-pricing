/**
 * Turning whatever a failed run threw into something a human can act on.
 *
 * The production run of 2026-08-27 03:00 recorded exactly this, and nothing
 * else:
 *
 * ```json
 * { "ran": true, "error": "[object Object]", "currencies": { "usd": { ... } } }
 * ```
 *
 * `String(err)` produced that. The thrown value was not an `Error`, so the
 * usual `err instanceof Error ? err.message : String(err)` fell through to the
 * `String()` branch and stringified a plain object into six useless words. The
 * container has since been restarted, so that string was - and is - the ONLY
 * surviving trace of the failure.
 *
 * A non-`Error` throw is not an accident here, it is the norm for anything
 * that goes through a Medusa workflow:
 *
 * - `TransactionOrchestrator.setStepFailure` calls `serializeError(error)`,
 *   which returns a PLAIN OBJECT `{ message, name, stack, ...ownProps }` - not
 *   an `Error` instance (`@medusajs/utils/dist/common/serialize-error.js`).
 * - `workflow-export.js` then throws that object as-is
 *   (`throw errors[0].error`), so every caller of `someWorkflow(container).run()`
 *   receives a POJO whose `message` is right there and whose `instanceof Error`
 *   is `false`.
 *
 * So the fix is not "log more", it is to stop asking `instanceof Error` and
 * start reading the shape that is actually thrown. `describeError` understands
 * all of it: real `Error`s, Medusa's serialized POJO, the
 * `{ action, handlerType, error }` wrapper the orchestrator keeps its errors
 * in, nested causes, and plain strings - and, for anything it genuinely cannot
 * recognise, it falls back to JSON rather than to `"[object Object]"`. There is
 * no input for which this returns a message with no information in it.
 */

/** A thrown value, reduced to the three things worth persisting about it. */
export interface DescribedError {
  /** Always non-empty, and never `"[object Object]"`. */
  message: string;
  /** The error class/name when the thrown value carried one. */
  name?: string;
  /** The stack when the thrown value carried one - Medusa's serialized errors do. */
  stack?: string;
}

/**
 * How deep to follow `.error` / `.cause` wrappers before giving up. The
 * orchestrator wraps at most twice in practice; the limit exists so a
 * self-referencing object cannot spin here.
 */
const MAX_UNWRAP_DEPTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Last resort: JSON, not `String()`. An object that reaches here still has its
 * keys and values printed, which is strictly more than `"[object Object]"`
 * ever was. A circular or otherwise unserializable value degrades to its type
 * tag, which at least says what it was.
 */
function stringifyUnknown(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_key, item: unknown) => {
      if (isRecord(item)) {
        if (seen.has(item)) {
          return "[circular]";
        }
        seen.add(item);
      }
      return item;
    });
    if (json !== undefined && json !== "{}" && json !== "null") {
      return json;
    }
  } catch {
    // fall through to the type tag below
  }
  return `unserializable thrown value (${Object.prototype.toString.call(value)})`;
}

/**
 * The failing workflow step's name, when the thrown value is the orchestrator's
 * `{ action, handlerType, error }` record. Worth keeping: it turns "the run
 * failed" into "`create-variant-pricing-link` failed", which is the difference
 * between guessing and knowing.
 */
function stepPrefix(value: Record<string, unknown>): string {
  const action = nonEmptyString(value.action);
  if (!action) {
    return "";
  }
  const handlerType = nonEmptyString(value.handlerType);
  return handlerType ? `${action} (${handlerType}): ` : `${action}: `;
}

function describeErrorAt(value: unknown, depth: number): DescribedError {
  if (value instanceof Error) {
    return {
      message: nonEmptyString(value.message) ?? value.name ?? "Error",
      name: value.name,
      stack: value.stack,
    };
  }

  const asString = nonEmptyString(value);
  if (asString) {
    return { message: asString };
  }

  if (!isRecord(value)) {
    return { message: stringifyUnknown(value) };
  }

  // An array of orchestrator errors: the first one is what `.run()` would have
  // thrown, and the rest are noted so a multi-step failure is not hidden.
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { message: "an empty error list was thrown" };
    }
    const first = describeErrorAt(value[0], depth + 1);
    if (value.length === 1) {
      return first;
    }
    return { ...first, message: `${first.message} (and ${value.length - 1} more)` };
  }

  // Medusa's serialized error: a plain object carrying the real message.
  const message = nonEmptyString(value.message);
  if (message) {
    return {
      message: stepPrefix(value) + message,
      name: nonEmptyString(value.name),
      stack: nonEmptyString(value.stack),
    };
  }

  // A wrapper around the real thing - the orchestrator's `{ action, error }`
  // record, or an ordinary `cause` chain.
  if (depth < MAX_UNWRAP_DEPTH) {
    for (const key of ["error", "cause"] as const) {
      if (value[key] !== undefined && value[key] !== null) {
        const inner = describeErrorAt(value[key], depth + 1);
        return { ...inner, message: stepPrefix(value) + inner.message };
      }
    }
  }

  return { message: stepPrefix(value) + stringifyUnknown(value) };
}

/** Reduce any thrown value to a persistable `{ message, name, stack }`. */
export function describeError(value: unknown): DescribedError {
  return describeErrorAt(value, 0);
}

/**
 * One line for a log: `"Name: message"`, or just the message when the thrown
 * value carried no useful name. The stack is deliberately NOT in here - it goes
 * to the run summary, where it can be read without flooding every log line.
 */
export function formatError(value: unknown): string {
  const described = describeError(value);
  if (!described.name || described.name === "Error" || described.message.startsWith(described.name)) {
    return described.message;
  }
  return `${described.name}: ${described.message}`;
}
