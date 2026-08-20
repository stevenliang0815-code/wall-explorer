export type HistoricalMarket = "上市" | "上櫃";

export type HistoricalObservation = {
  market: HistoricalMarket;
  code: string;
  name: string;
  tradingDate: string;
  securityType: "ordinary_equity_candidate" | "other_security";
  universeStatus: "traded_or_quoted" | "present_no_quote";
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  change: number | null;
  volume: number | null;
  tradeValue: number | null;
  source: string;
  sourceScope: "full_market_daily";
  usableFrom: string;
};

type OfficialTable = {
  title?: string;
  fields?: unknown[];
  data?: unknown[];
};

type OfficialReport = {
  stat?: string;
  date?: string;
  tables?: OfficialTable[];
};

type LegacyTpexReport = {
  aaData?: unknown[];
  date?: string;
  reportDate?: string;
};

export type FetchProfile = {
  networkMs: number;
  parseMs: number;
  retryCount: number;
  throttledMs: number;
  rateLimited: boolean;
  attempts: number;
};

export const BACKFILL_POLICY = Object.freeze({
  version: "pit-v2.2-bulk",
  targetStart: "2010-01-04",
  universe: "official_full_market_as_of_each_date",
  usesCurrentListings: false,
  featureAvailability: "next_calendar_day_00_taipei",
});

const FIELD_ALIASES = {
  code: ["證券代號", "代號", "股票代號"],
  name: ["證券名稱", "名稱", "股票名稱"],
  open: ["開盤價", "開盤"],
  high: ["最高價", "最高"],
  low: ["最低價", "最低"],
  close: ["收盤價", "收盤"],
  direction: ["漲跌(+/-)", "漲跌(+／-)", "漲跌符號"],
  change: ["漲跌價差", "漲跌"],
  volume: ["成交股數", "成交張數"],
  tradeValue: ["成交金額", "成交仟元"],
} as const;

function cleanText(value: unknown) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/\u2212/g, "-")
    .trim();
}

function cleanLabel(value: unknown) {
  return cleanText(value).replace(/\s+/g, "");
}

function findField(fields: string[], aliases: readonly string[]) {
  return fields.findIndex((field) => aliases.some((alias) => field === cleanLabel(alias)));
}

function numberValue(value: unknown): number | null {
  const clean = cleanText(value).replace(/,/g, "").replace(/^\+/, "");
  if (!clean || /^(--|---|-|X|N\/A)$/i.test(clean)) return null;
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : null;
}

function nextCalendarDayTaipei(tradingDate: string) {
  const day = new Date(`${tradingDate}T12:00:00+08:00`);
  day.setUTCDate(day.getUTCDate() + 1);
  return `${day.toISOString().slice(0, 10)}T00:00:00+08:00`;
}

function normalizeOfficialDate(value: unknown) {
  const digits = cleanText(value).replace(/\D/g, "");
  if (digits.length === 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  if (digits.length === 7) return `${Number(digits.slice(0, 3)) + 1911}-${digits.slice(3, 5)}-${digits.slice(5, 7)}`;
  return null;
}

export function historicalSourceUrl(market: HistoricalMarket, tradingDate: string) {
  if (market === "上市") {
    const date = tradingDate.replace(/-/g, "");
    return `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${date}&type=ALLBUT0999&response=json`;
  }
  const params = new URLSearchParams({ date: tradingDate.replace(/-/g, "/"), id: "", response: "json" });
  return `https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?${params.toString()}`;
}

export function historicalSourceUrls(market: HistoricalMarket, tradingDate: string) {
  if (market === "上市") return [historicalSourceUrl(market, tradingDate)];
  const rocYear = Number(tradingDate.slice(0, 4)) - 1911;
  const rocDate = `${rocYear}/${tradingDate.slice(5, 7)}/${tradingDate.slice(8, 10)}`;
  const legacy = new URL("https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php");
  legacy.searchParams.set("l", "zh-tw");
  legacy.searchParams.set("o", "json");
  legacy.searchParams.set("d", rocDate);
  return [historicalSourceUrl(market, tradingDate), legacy.toString()];
}

function rowCells(row: unknown, fields: string[]) {
  if (Array.isArray(row)) return row;
  if (row && typeof row === "object") {
    const record = row as Record<string, unknown>;
    return fields.map((field) => record[field]);
  }
  return [];
}

export function parseHistoricalReport(report: OfficialReport, market: HistoricalMarket, tradingDate: string, source: string) {
  const observations: HistoricalObservation[] = [];
  const seen = new Set<string>();

  for (const table of report.tables ?? []) {
    const fields = (table.fields ?? []).map(cleanLabel);
    const codeIndex = findField(fields, FIELD_ALIASES.code);
    const nameIndex = findField(fields, FIELD_ALIASES.name);
    const closeIndex = findField(fields, FIELD_ALIASES.close);
    if (codeIndex < 0 || nameIndex < 0 || closeIndex < 0) continue;

    const openIndex = findField(fields, FIELD_ALIASES.open);
    const highIndex = findField(fields, FIELD_ALIASES.high);
    const lowIndex = findField(fields, FIELD_ALIASES.low);
    const directionIndex = findField(fields, FIELD_ALIASES.direction);
    const changeIndex = findField(fields, FIELD_ALIASES.change);
    const volumeIndex = findField(fields, FIELD_ALIASES.volume);
    const tradeValueIndex = findField(fields, FIELD_ALIASES.tradeValue);
    const volumeMultiplier = fields[volumeIndex] === "成交張數" ? 1_000 : 1;
    const valueMultiplier = fields[tradeValueIndex] === "成交仟元" ? 1_000 : 1;

    for (const rawRow of table.data ?? []) {
      const cells = rowCells(rawRow, fields);
      const code = cleanText(cells[codeIndex]);
      const name = cleanText(cells[nameIndex]);
      if (!code || !name || seen.has(code)) continue;
      seen.add(code);

      const rawChange = changeIndex >= 0 ? numberValue(cells[changeIndex]) : null;
      const direction = directionIndex >= 0 ? cleanText(cells[directionIndex]) : "";
      const change = rawChange === null ? null : direction.includes("-") ? -Math.abs(rawChange) : rawChange;
      const volume = volumeIndex >= 0 ? numberValue(cells[volumeIndex]) : null;
      const tradeValue = tradeValueIndex >= 0 ? numberValue(cells[tradeValueIndex]) : null;
      const close = numberValue(cells[closeIndex]);

      observations.push({
        market,
        code,
        name,
        tradingDate,
        securityType: /^[1-9]\d{3}$/.test(code) ? "ordinary_equity_candidate" : "other_security",
        universeStatus: close === null ? "present_no_quote" : "traded_or_quoted",
        open: openIndex >= 0 ? numberValue(cells[openIndex]) : null,
        high: highIndex >= 0 ? numberValue(cells[highIndex]) : null,
        low: lowIndex >= 0 ? numberValue(cells[lowIndex]) : null,
        close,
        change,
        volume: volume === null ? null : Math.round(volume * volumeMultiplier),
        tradeValue: tradeValue === null ? null : tradeValue * valueMultiplier,
        source,
        sourceScope: "full_market_daily",
        usableFrom: nextCalendarDayTaipei(tradingDate),
      });
    }
  }

  return observations;
}

export function parseLegacyTpexReport(report: LegacyTpexReport, tradingDate: string, source: string) {
  const observations: HistoricalObservation[] = [];
  const seen = new Set<string>();
  for (const rawRow of report.aaData ?? []) {
    if (!Array.isArray(rawRow)) continue;
    const code = cleanText(rawRow[0]);
    const name = cleanText(rawRow[1]);
    if (!code || !name || seen.has(code)) continue;
    seen.add(code);
    const close = numberValue(rawRow[2]);
    const volume = numberValue(rawRow[8]);
    const tradeValue = numberValue(rawRow[9]);
    observations.push({
      market: "上櫃",
      code,
      name,
      tradingDate,
      securityType: /^[1-9]\d{3}$/.test(code) ? "ordinary_equity_candidate" : "other_security",
      universeStatus: close === null ? "present_no_quote" : "traded_or_quoted",
      open: numberValue(rawRow[4]),
      high: numberValue(rawRow[5]),
      low: numberValue(rawRow[6]),
      close,
      change: numberValue(rawRow[3]),
      volume: volume === null ? null : Math.round(volume),
      tradeValue,
      source,
      sourceScope: "full_market_daily",
      usableFrom: nextCalendarDayTaipei(tradingDate),
    });
  }
  return observations;
}

export function auditBiasGuards(observations: HistoricalObservation[], tradingDate: string) {
  const survivorshipViolations = observations.filter((row) => row.sourceScope !== "full_market_daily").length;
  const lookAheadViolations = observations.filter((row) => row.tradingDate !== tradingDate || row.usableFrom.slice(0, 10) <= tradingDate).length;
  return {
    survivorship: {
      status: survivorshipViolations === 0 ? "pass" as const : "blocked" as const,
      violations: survivorshipViolations,
      rule: "母體只能來自該交易日官方全市場表；禁止用目前上市櫃名單回推。",
    },
    lookAhead: {
      status: lookAheadViolations === 0 ? "pass" as const : "blocked" as const,
      violations: lookAheadViolations,
      rule: "盤後日資料一律到下一個日曆日 00:00（台北時間）才可成為模型特徵。",
    },
  };
}

const hostLastRequest = new Map<string, number>();
const FETCH_POLICY = Object.freeze({ timeoutMs: 8_000, maxAttempts: 3, hostSpacingMs: 350, backoffBaseMs: 400 });

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForHostSlot(source: string) {
  const host = new URL(source).host;
  const elapsed = Date.now() - (hostLastRequest.get(host) ?? 0);
  const waitMs = Math.max(0, FETCH_POLICY.hostSpacingMs - elapsed);
  if (waitMs) await delay(waitMs);
  hostLastRequest.set(host, Date.now());
  return waitMs;
}

function retryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function fetchHistoricalMarketDay(market: HistoricalMarket, tradingDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDate)) throw new Error("Invalid trading date");
  const profile: FetchProfile = { networkMs: 0, parseMs: 0, retryCount: 0, throttledMs: 0, rateLimited: false, attempts: 0 };
  const sources = historicalSourceUrls(market, tradingDate);
  let lastError: Error | null = null;

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const source = sources[sourceIndex];
    const attempts = sourceIndex === 0 && market === "上櫃" ? 1 : FETCH_POLICY.maxAttempts;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      profile.attempts += 1;
      const throttled = await waitForHostSlot(source);
      profile.throttledMs += throttled;
      try {
        const networkStarted = performance.now();
        const response = await fetch(source, {
          headers: {
            Accept: "application/json",
            "User-Agent": "WallExplorerV2/2.2-bulk",
            Referer: market === "上市"
              ? "https://www.twse.com.tw/zh/trading/historical/mi-index.html"
              : "https://www.tpex.org.tw/zh-tw/mainboard/trading/info/pricing.html",
          },
          signal: AbortSignal.timeout(FETCH_POLICY.timeoutMs),
          cache: "no-store",
          redirect: "follow",
        });
        const body = await response.text();
        profile.networkMs += performance.now() - networkStarted;
        if (!response.ok) {
          const error = new Error(`Official historical source returned ${response.status}`);
          if (!retryableStatus(response.status)) throw error;
          if (response.status === 429) profile.rateLimited = true;
          throw error;
        }

        const parseStarted = performance.now();
        const report = JSON.parse(body) as OfficialReport & LegacyTpexReport;
        const observations = source.includes("stk_quote_result.php")
          ? parseLegacyTpexReport(report, tradingDate, source)
          : parseHistoricalReport(report, market, tradingDate, source);
        profile.parseMs += performance.now() - parseStarted;
        const officialDate = normalizeOfficialDate(report.date ?? report.reportDate);
        if (observations.length && officialDate && officialDate !== tradingDate) {
          throw new Error(`Official date mismatch: requested ${tradingDate}, received ${officialDate}`);
        }
        return {
          source,
          observations,
          officialStatus: report.stat ?? null,
          officialDate: officialDate ?? tradingDate,
          profile,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Unknown official source error");
        const isLast = attempt + 1 >= attempts;
        if (isLast) break;
        profile.retryCount += 1;
        const backoff = FETCH_POLICY.backoffBaseMs * 2 ** attempt + Math.floor(Math.random() * 150);
        profile.throttledMs += backoff;
        await delay(backoff);
      }
    }
  }
  throw Object.assign(lastError ?? new Error("Official historical source unavailable"), { fetchProfile: profile });
}
