import assert from "node:assert/strict";
import test from "node:test";
import { auditBiasGuards, BACKFILL_POLICY, parseHistoricalReport } from "../lib/historical-data.ts";

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
