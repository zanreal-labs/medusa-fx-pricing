import { describe, expect, it, vi } from "vitest";
import { fetchNbpRate, isRateStale, parseNbpRatesResponse } from "../nbp";

/** A realistic `GET /api/exchangerates/rates/a/usd/` response body. */
const USD_RESPONSE = {
  code: "USD",
  currency: "dolar amerykański",
  rates: [
    {
      effectiveDate: "2026-08-11",
      mid: 3.9123,
      no: "154/A/NBP/2026",
    },
  ],
  table: "A",
};

describe("parseNbpRatesResponse", () => {
  it("parses a well-formed NBP table A response", () => {
    const result = parseNbpRatesResponse(USD_RESPONSE, "usd");
    expect(result).toEqual({
      currency: "usd",
      effectiveDate: "2026-08-11",
      mid: 3.9123,
      tableNo: "154/A/NBP/2026",
    });
  });

  it("uses the first rates entry as the latest/current one", () => {
    const twoEntries = {
      ...USD_RESPONSE,
      rates: [
        { effectiveDate: "2026-08-11", mid: 3.9123, no: "154/A/NBP/2026" },
        { effectiveDate: "2026-08-08", mid: 3.91, no: "153/A/NBP/2026" },
      ],
    };
    expect(parseNbpRatesResponse(twoEntries, "usd").mid).toBe(3.9123);
  });

  it("throws when the response is not an object", () => {
    expect(() => parseNbpRatesResponse(null, "usd")).toThrow(/JSON object/);
    expect(() => parseNbpRatesResponse("oops", "usd")).toThrow(/JSON object/);
  });

  it("throws when rates is missing or empty", () => {
    expect(() => parseNbpRatesResponse({ ...USD_RESPONSE, rates: [] }, "usd")).toThrow(
      /no "rates" entries/,
    );
    expect(() => parseNbpRatesResponse({ table: "A" }, "usd")).toThrow(/no "rates" entries/);
  });

  it("throws when mid is missing, non-numeric, or non-positive", () => {
    expect(() =>
      parseNbpRatesResponse({ rates: [{ effectiveDate: "2026-08-11" }] }, "usd"),
    ).toThrow(/"mid" rate/);
    expect(() =>
      parseNbpRatesResponse({ rates: [{ effectiveDate: "2026-08-11", mid: "abc" }] }, "usd"),
    ).toThrow(/"mid" rate/);
    expect(() =>
      parseNbpRatesResponse({ rates: [{ effectiveDate: "2026-08-11", mid: 0 }] }, "usd"),
    ).toThrow(/"mid" rate/);
    expect(() =>
      parseNbpRatesResponse({ rates: [{ effectiveDate: "2026-08-11", mid: -1 }] }, "usd"),
    ).toThrow(/"mid" rate/);
  });

  it("throws when effectiveDate is missing", () => {
    expect(() => parseNbpRatesResponse({ rates: [{ mid: 3.91 }] }, "usd")).toThrow(
      /"effectiveDate"/,
    );
  });

  it("tolerates a missing table number, defaulting to an empty string", () => {
    const result = parseNbpRatesResponse(
      { rates: [{ effectiveDate: "2026-08-11", mid: 3.91 }] },
      "eur",
    );
    expect(result.tableNo).toBe("");
    expect(result.currency).toBe("eur");
  });
});

describe("fetchNbpRate", () => {
  it("fetches the currency-specific endpoint with no date suffix (NBP always answers with the latest table)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => USD_RESPONSE,
      ok: true,
      status: 200,
    });
    const result = await fetchNbpRate("usd", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.nbp.pl/api/exchangerates/rates/a/usd/",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(result.mid).toBe(3.9123);
  });

  it("throws with the HTTP status when the request fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({}),
      ok: false,
      status: 404,
    });
    await expect(fetchNbpRate("eur", fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /status 404/,
    );
  });
});

describe("isRateStale", () => {
  const now = new Date("2026-08-13T12:00:00.000Z");

  it("is not stale on the same day", () => {
    expect(isRateStale({ effectiveDate: "2026-08-13" }, now, 120)).toBe(false);
  });

  it("is not stale across an ordinary weekend gap (Friday's rate, checked Monday)", () => {
    // Friday 2026-08-07 -> Monday 2026-08-10, about 72 hours - well inside a
    // 120-hour (5 day) tolerance.
    expect(isRateStale({ effectiveDate: "2026-08-07" }, new Date("2026-08-10T09:00:00.000Z"), 120)).toBe(
      false,
    );
  });

  it("is stale once the age exceeds the tolerance", () => {
    // 2026-08-13 minus 2026-08-01 is 12 days, well past a 120-hour tolerance.
    expect(isRateStale({ effectiveDate: "2026-08-01" }, now, 120)).toBe(true);
  });

  it("treats an unparsable effectiveDate as stale (fails closed)", () => {
    expect(isRateStale({ effectiveDate: "not-a-date" }, now, 120)).toBe(true);
  });
});
