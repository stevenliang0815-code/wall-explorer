import assert from "node:assert/strict";
import test from "node:test";
import {
  auditBiasGuards,
  BACKFILL_POLICY,
  fetchHistoricalMarketDay,
  historicalSourceUrls,
  HistoricalUnitError,
  parseHistoricalReport,
  parseLegacyTpexReport,
} from "../lib/historical-data.ts";

test("point-in-time parser retains securities without consulting today's listing directory", () => {
  const report = {
    stat: "OK",
    date: "20200102",
    tables: [{
      title: "每日收盤行情",
      fields: ["證券代號", "證券名稱", "成交股數", "成交金額", "開盤價", "最高價", "最低價", "收盤價", "漲跌(+/-)", "漲跌價差"],
      data: [
        ["1101", "台泥", "1,000", "50,000", "49", "51", "48", "50", "+", "1"],
        ["1234", "後來終止上市樣本", "2,000", "80,000", "39", "41", "38", "40", "-", "2"],
        ["0050", "ETF樣本", "3,000", "120,000", "39", "41", "38", "40", "+", "1"],
      ],
    }],
  };

  const rows = parseHistoricalReport(report, "上市", "2020-01-02", "https://official.example/day");
  assert.equal(BACKFILL_POLICY.usesCurrentListings, false);
  assert.equal(BACKFILL_POLICY.targetStart, "2010-01-04");
  assert.deepEqual(rows.map((row) => row.code), ["1101", "1234", "0050"]);
  assert.equal(rows[1].change, -2);
  assert.equal(rows[1].usableFrom, "2020-01-03T00:00:00+08:00");
  assert.equal(rows[2].securityType, "other_security");
  assert.equal(auditBiasGuards(rows, "2020-01-02").survivorship.status, "pass");
});

test("look-ahead audit blocks same-day feature availability", () => {
  const rows = parseHistoricalReport({
    tables: [{ fields: ["代號", "名稱", "收盤", "成交張數", "成交仟元"], data: [["5274", "信驊", "5000", "12", "60,000"]] }],
  }, "上櫃", "2020-01-02", "https://official.example/day");
  assert.equal(rows[0].volume, 12_000);
  assert.equal(rows[0].tradeValue, 60_000_000);
  const invalid = [{ ...rows[0], usableFrom: "2020-01-02T16:30:00+08:00" }];
  const audit = auditBiasGuards(invalid, "2020-01-02");
  assert.equal(audit.lookAhead.status, "blocked");
  assert.equal(audit.lookAhead.violations, 1);
});

test("legacy TPEx full-market fallback keeps delisted candidates and point-in-time availability", () => {
  const rows = parseLegacyTpexReport({ aaData: [
    ["5274", "信驊", "5,000", "25", "4,980", "5,020", "4,950", "4,990", "12,000", "60,000,000"],
    ["1234", "後來下櫃樣本", "40", "-2", "42", "43", "39", "41", "2,000", "80,000"],
  ] }, "2020-01-02", "https://www.tpex.org.tw/official-full-market");
  assert.deepEqual(rows.map((row) => row.code), ["5274", "1234"]);
  assert.equal(rows[1].change, -2);
  assert.equal(rows[1].usableFrom, "2020-01-03T00:00:00+08:00");
  assert.equal(auditBiasGuards(rows, "2020-01-02").lookAhead.status, "pass");
  const sources = historicalSourceUrls("上櫃", "2020-01-02");
  assert.match(sources[0], /\/www\/zh-tw\/afterTrading\/dailyQuotes/);
  assert.match(sources[1], /daily_close_quotes\/stk_quote_result\.php/);
});

test("transient redirect/429/5xx responses use exponential backoff and then continue", async () => {
  const responses = [
    new Response(null, { status: 307 }),
    new Response("rate limited", { status: 429 }),
    new Response("busy", { status: 503 }),
    new Response(JSON.stringify({ stat: "OK", date: "20250417", tables: [{
      fields: ["證券代號", "證券名稱", "收盤價"],
      data: [["1101", "台泥", "40"]],
    }] }), { status: 200 }),
  ];
  const delays: number[] = [];
  let calls = 0;
  const result = await fetchHistoricalMarketDay("上市", "2025-04-17", {
    fetchImpl: async () => responses[calls++],
    delayImpl: async (ms) => { delays.push(ms); },
    random: () => 0,
    hostSpacingMs: 0,
    backoffBaseMs: 10,
    maxBackoffMs: 100,
  });
  assert.equal(calls, 4);
  assert.deepEqual(delays, [10, 20, 40]);
  assert.equal(result.profile.retryCount, 3);
  assert.equal(result.profile.rateLimited, true);
  assert.equal(result.unitStatus, "completed");
  assert.equal(result.observations.length, 1);
});

test("official confirmed no-data becomes a validated empty unit", async () => {
  const result = await fetchHistoricalMarketDay("上市", "2025-04-17", {
    fetchImpl: async () => new Response(JSON.stringify({ stat: "很抱歉，沒有符合條件的資料!", date: "20250417" }), { status: 200 }),
    delayImpl: async () => {},
    hostSpacingMs: 0,
  });
  assert.equal(result.unitStatus, "validated_empty");
  assert.equal(result.observations.length, 0);
  assert.match(result.emptyReason, /沒有符合條件/);
});

test("parsing and schema failures hard-stop without retry or fallback", async () => {
  for (const body of ["<html>not json</html>", JSON.stringify({ stat: "OK", tables: [{ fields: ["unexpected"], data: [["x"]] }] })]) {
    let calls = 0;
    const delays: number[] = [];
    await assert.rejects(
      fetchHistoricalMarketDay("上櫃", "2025-04-17", {
        fetchImpl: async () => { calls += 1; return new Response(body, { status: 200 }); },
        delayImpl: async (ms) => { delays.push(ms); },
        hostSpacingMs: 0,
      }),
      (error) => error instanceof HistoricalUnitError && !error.retryable && ["parsing", "schema"].includes(error.category),
    );
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
  }
});

test("an exhausted network hole remains classified transient after bounded retries", async () => {
  let calls = 0;
  await assert.rejects(
    fetchHistoricalMarketDay("上市", "2025-04-17", {
      fetchImpl: async () => { calls += 1; throw new TypeError("fetch failed: ETIMEDOUT"); },
      delayImpl: async () => {},
      random: () => 0,
      maxAttempts: 3,
      hostSpacingMs: 0,
      backoffBaseMs: 0,
      maxBackoffMs: 0,
    }),
    (error) => error instanceof HistoricalUnitError && error.category === "transient" && /after 3 attempts/.test(error.message),
  );
  assert.equal(calls, 3);
});
