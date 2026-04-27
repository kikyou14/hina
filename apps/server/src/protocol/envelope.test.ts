import { describe, expect, test } from "bun:test";

import { parseProbeResultBody } from "./envelope";

const RECV_TS = 1_700_000_000_000;

function buildBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { tid: "task-1", ts: RECV_TS, ok: true, ...overrides };
}

describe("parseProbeResultBody ts bounds", () => {
  test("accepts ts equal to recvTsMs", () => {
    const result = parseProbeResultBody(buildBody({ ts: RECV_TS }), RECV_TS);
    expect(result?.ts).toBe(RECV_TS);
  });

  test("accepts delayed past ts", () => {
    const ts = RECV_TS - 60 * 60 * 1000;
    expect(parseProbeResultBody(buildBody({ ts }), RECV_TS)?.ts).toBe(ts);
  });

  test("accepts a delayed serial-traceroute result lagging ~10 minutes", () => {
    const ts = RECV_TS - 10 * 60 * 1000;
    expect(parseProbeResultBody(buildBody({ ts }), RECV_TS)?.ts).toBe(ts);
  });

  test("accepts ts within future tolerance window", () => {
    const ts = RECV_TS + 60 * 1000;
    expect(parseProbeResultBody(buildBody({ ts }), RECV_TS)?.ts).toBe(ts);
  });

  test("rejects ts beyond future tolerance", () => {
    const ts = RECV_TS + 60 * 1000 + 1;
    expect(parseProbeResultBody(buildBody({ ts }), RECV_TS)).toBeNull();
  });

  test("rejects MAX_SAFE_INTEGER ts that would otherwise poison probe_result_latest", () => {
    expect(parseProbeResultBody(buildBody({ ts: Number.MAX_SAFE_INTEGER }), RECV_TS)).toBeNull();
  });

  test("rejects ts = 0 even when recvTsMs is small", () => {
    expect(parseProbeResultBody(buildBody({ ts: 0 }), 1_000)).toBeNull();
  });

  test("rejects non-integer ts", () => {
    expect(parseProbeResultBody(buildBody({ ts: RECV_TS + 0.5 }), RECV_TS)).toBeNull();
  });
});
