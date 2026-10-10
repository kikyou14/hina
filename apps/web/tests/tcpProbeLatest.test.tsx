import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";

import type { PublicProbeLatest } from "../src/api/public";
import en from "../src/locales/en/translation.json";
import zh from "../src/locales/zh/translation.json";
import { LatencyCard } from "../src/pages/public/components/LatencyCard";
import { TcpProbeLatest } from "../src/pages/public/components/TcpProbeLatest";

const latest: PublicProbeLatest = {
  tsMs: Date.UTC(2026, 9, 10, 1, 2, 3),
  recvTsMs: Date.UTC(2026, 9, 10, 1, 2, 4),
  ok: false,
  latMs: null,
  code: null,
  err: "packet_too_large",
  extra: { packet_size_bytes: 1200 },
  extraParseError: false,
  extraRawJson: null,
  lossPct: null,
  jitterMs: null,
  updatedAtMs: 0,
};

async function translator(lng = "en") {
  const instance = createInstance();
  await instance.init({
    lng,
    resources: { en: { translation: en }, zh: { translation: zh } },
    interpolation: { escapeValue: false },
  });
  return instance;
}

describe("TCP latest result rendering", () => {
  test("failure remains visible with no chart points or successful statistics", async () => {
    const i18n = await translator();
    const results = [
      {
        task: {
          id: "task",
          name: "TCP test",
          kind: "tcp" as const,
          enabled: true,
          intervalSec: 60,
          updatedAtMs: 0,
        },
        latest,
      },
    ];
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <LatencyCard
          probeLatestLoading={false}
          probeLatestError={null}
          allProbeResults={results}
          latencyProbeResults={results}
          selectedProbeTaskIds={["task"]}
          setSelectedProbeTaskIds={() => {}}
          latencyWindow="1h"
          setLatencyWindow={() => {}}
          latencyChartData={[]}
          latencyLines={[]}
          latencyXTickFormatter={String}
          latencyStatsByTaskId={new Map()}
          latencySeriesLoading={false}
          firstProbeSeriesError={null}
        />
      </I18nextProvider>,
    );
    expect(html).toContain("Latest probe");
    expect(html).toContain("Failed");
    expect(html).toContain("Packet exceeds the permitted MTU");
    expect(html).toContain("1200 B");
    expect(html).toContain("2026");
  });

  test("success shows the latest latency without stale failure text", async () => {
    const i18n = await translator();
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <TcpProbeLatest
          latest={{ ...latest, ok: true, latMs: 12, extra: { packet_size_bytes: 40 } }}
        />
      </I18nextProvider>,
    );
    expect(html).toContain("Success");
    expect(html).toContain("12 ms");
    expect(html).not.toContain("ms ms");
    expect(html).toContain("40 B");
    expect(html).not.toContain("MTU");
  });

  test("unknown errors and metadata never render raw diagnostics", async () => {
    const i18n = await translator();
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <TcpProbeLatest
          latest={{
            ...latest,
            err: "private.example: connection failed",
            extra: { host: "private.example", packet_size_bytes: "1200" },
          }}
        />
      </I18nextProvider>,
    );
    expect(html).toContain("Failed");
    expect(html).not.toContain("private.example");
    expect(html).not.toContain("1200 B");
  });

  test.each(Object.keys(en.probes.tcpResult.errors))(
    "translates the known error %s in both languages",
    async (err) => {
      for (const lng of ["en", "zh"] as const) {
        const i18n = await translator(lng);
        const html = renderToStaticMarkup(
          <I18nextProvider i18n={i18n}>
            <TcpProbeLatest latest={{ ...latest, err }} />
          </I18nextProvider>,
        );
        expect(html).toContain(i18n.t(`probes.tcpResult.errors.${err}`));
        expect(html).not.toContain("probes.tcpResult");
      }
    },
  );
});
