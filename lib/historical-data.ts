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

export type HistoricalUnitFailureCategory = "transient" | "parsing" | "schema" | "integrity" | "source_rejected";

export class HistoricalUnitError extends Error {
  readonly category: HistoricalUnitFailureCategory;
  readonly retryable: boolean;

  constructor(category: HistoricalUnitFailureCategory, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "HistoricalUnitError";
    this.category = category;
    this.retryable = category === "transient";
  }
}

export function classifyHistoricalUnitError(error: unknown) {
  if (error instanceof HistoricalUnitError) return error;
  if (error instanceof SyntaxError) return new HistoricalUnitError("parsing", `Official JSON parsing failed: ${error.message}`, { cause: error });
  const value = error instanceof Error ? error : new Error(String(error ?? "Unknown error"));
  if (value.name === "AbortError" || value.name === "TimeoutError" || value instanceof TypeError || /(?:network|fetch failed|socket|ECONN|ETIMEDOUT|EAI_AGAIN)/i.test(value.message)) {
    return new HistoricalUnitError("transient", value.message, { cause: value });
  }
  return new HistoricalUnitError("integrity", value.message, { cause: value });
}

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
  return [historicalSourceUrl(market, tradingDate)];
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

const hostNextRequestAt = new Map<string, number>();
const FETCH_POLICY = Object.freeze({ twseTimeoutMs: 10_000, tpexTimeoutMs: 20_000, maxAttempts: 6, hostSpacingMs: 350, backoffBaseMs: 1_000, maxBackoffMs: 30_000 });

type FetchHistoricalOptions = {
  fetchImpl?: typeof fetch;
  delayImpl?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  timeoutMs?: number;
  hostSpacingMs?: number;
  backoffBaseMs?: number;
  maxBackoffMs?: number;
};

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForHostSlot(source: string, spacingMs: number, delayImpl: (ms: number) => Promise<void>) {
  const host = new URL(source).host;
  const now = Date.now();
  const reservedAt = Math.max(now, hostNextRequestAt.get(host) ?? now);
  hostNextRequestAt.set(host, reservedAt + spacingMs);
  const waitMs = Math.max(0, reservedAt - now);
  if (waitMs) await delayImpl(waitMs);
  return waitMs;
}

function retryableStatus(status: number) {
  return (status >= 300 && status < 400) || status === 408 || status === 425 || status === 429 || status >= 500;
}

const OFFICIAL_EMPTY_STATUS = /(?:沒有符合條件|查無資料|無交易資料|無資料|休市|尚無資料|no\s*data)/i;
const OFFICIAL_TRANSIENT_STATUS = /(?:系統忙碌|稍後再試|暫時無法|逾時|busy|temporar|timeout)/i;

function tableHasHistoricalSchema(table: OfficialTable) {
  const fields = (table.fields ?? []).map(cleanLabel);
  return findField(fields, FIELD_ALIASES.code) >= 0 && findField(fields, FIELD_ALIASES.name) >= 0 && findField(fields, FIELD_ALIASES.close) >= 0;
}

function interpretOfficialPayload(report: OfficialReport & LegacyTpexReport, market: HistoricalMarket, tradingDate: string, source: string) {
  const officialStatus = cleanText(report.stat);
  const officialDate = normalizeOfficialDate(report.date ?? report.reportDate);
  if (officialDate && officialDate !== tradingDate) {
    throw new HistoricalUnitError("schema", `Official date mismatch: requested ${tradingDate}, received ${officialDate}`);
  }
  if (OFFICIAL_TRANSIENT_STATUS.test(officialStatus)) {
    throw new HistoricalUnitError("transient", `Official source is temporarily unavailable: ${officialStatus}`);
  }
  const officialEmpty = OFFICIAL_EMPTY_STATUS.test(officialStatus);
  if (officialStatus && officialStatus.toUpperCase() !== "OK" && !officialEmpty) {
    throw new HistoricalUnitError("schema", `Unrecognized official status: ${officialStatus}`);
  }

  if (Array.isArray(report.tables)) {
    const matching = report.tables.filter(tableHasHistoricalSchema);
    if (!matching.length) {
      if (officialEmpty || report.tables.length === 0) {
        return { observations: [] as HistoricalObservation[], unitStatus: "validated_empty" as const, emptyReason: officialEmpty ? officialStatus : "official-empty-tables", officialStatus, officialDate: officialDate ?? tradingDate };
      }
      throw new HistoricalUnitError("schema", "Official payload has tables but no recognizable full-market price table");
    }
    const observations = parseHistoricalReport({ ...report, tables: matching }, market, tradingDate, source);
    const rawRows = matching.reduce((sum, table) => sum + (Array.isArray(table.data) ? table.data.length : 0), 0);
    if (!observations.length && rawRows > 0) throw new HistoricalUnitError("schema", "Official full-market table contains rows but none can be parsed");
    if (!observations.length) {
      return { observations, unitStatus: "validated_empty" as const, emptyReason: officialEmpty ? officialStatus : "official-empty-market-table", officialStatus, officialDate: officialDate ?? tradingDate };
    }
    return { observations, unitStatus: "completed" as const, emptyReason: null, officialStatus, officialDate: officialDate ?? tradingDate };
  }

  if (source.includes("stk_quote_result.php") && Array.isArray(report.aaData)) {
    const observations = parseLegacyTpexReport(report, tradingDate, source);
    if (!observations.length && report.aaData.length > 0) throw new HistoricalUnitError("schema", "Official TPEx fallback contains rows but none can be parsed");
    return observations.length
      ? { observations, unitStatus: "completed" as const, emptyReason: null, officialStatus, officialDate: officialDate ?? tradingDate }
      : { observations, unitStatus: "validated_empty" as const, emptyReason: officialEmpty ? officialStatus : "official-empty-aaData", officialStatus, officialDate: officialDate ?? tradingDate };
  }

  if (officialEmpty) {
    return { observations: [] as HistoricalObservation[], unitStatus: "validated_empty" as const, emptyReason: officialStatus, officialStatus, officialDate: officialDate ?? tradingDate };
  }
  throw new HistoricalUnitError("schema", "Official payload schema is missing tables/aaData");
}

export async function fetchHistoricalMarketDay(market: HistoricalMarket, tradingDate: string, options: FetchHistoricalOptions = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDate)) throw new HistoricalUnitError("schema", "Invalid trading date");
  const profile: FetchProfile = { networkMs: 0, parseMs: 0, retryCount: 0, throttledMs: 0, rateLimited: false, attempts: 0 };
  const sources = historicalSourceUrls(market, tradingDate);
  const fetchImpl = options.fetchImpl ?? fetch;
  const delayImpl = options.delayImpl ?? delay;
  const random = options.random ?? Math.random;
  const maxAttempts = Math.max(1, options.maxAttempts ?? FETCH_POLICY.maxAttempts);
  const timeoutMs = Math.max(1, options.timeoutMs ?? (market === "上櫃" ? FETCH_POLICY.tpexTimeoutMs : FETCH_POLICY.twseTimeoutMs));
  const hostSpacingMs = Math.max(0, options.hostSpacingMs ?? FETCH_POLICY.hostSpacingMs);
  const backoffBaseMs = Math.max(0, options.backoffBaseMs ?? FETCH_POLICY.backoffBaseMs);
  const maxBackoffMs = Math.max(backoffBaseMs, options.maxBackoffMs ?? FETCH_POLICY.maxBackoffMs);
  let lastError: HistoricalUnitError | null = null;

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const source = sources[sourceIndex];
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      profile.attempts += 1;
      const throttled = await waitForHostSlot(source, hostSpacingMs, delayImpl);
      profile.throttledMs += throttled;
      const networkStarted = performance.now();
      let networkRecorded = false;
      try {
        const response = await fetchImpl(source, {
          headers: {
            Accept: "application/json",
            "User-Agent": "WallExplorerV2/2.2-bulk",
            Referer: market === "上市"
              ? "https://www.twse.com.tw/zh/trading/historical/mi-index.html"
              : "https://www.tpex.org.tw/zh-tw/mainboard/trading/info/pricing.html",
          },
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store",
          redirect: "follow",
        });
        const body = await response.text();
        profile.networkMs += performance.now() - networkStarted;
        networkRecorded = true;
        if (!response.ok) {
          const category = retryableStatus(response.status) ? "transient" : "source_rejected";
          if (response.status === 429) profile.rateLimited = true;
          throw new HistoricalUnitError(category, `Official historical source returned ${response.status}`);
        }

        const parseStarted = performance.now();
        let report: OfficialReport & LegacyTpexReport;
        try {
          report = JSON.parse(body) as OfficialReport & LegacyTpexReport;
        } catch (error) {
          throw new HistoricalUnitError("parsing", `Official JSON parsing failed: ${error instanceof Error ? error.message : "invalid JSON"}`, { cause: error });
        }
        const interpreted = interpretOfficialPayload(report, market, tradingDate, source);
        profile.parseMs += performance.now() - parseStarted;
        return { source, ...interpreted, profile };
      } catch (error) {
        if (!networkRecorded) profile.networkMs += performance.now() - networkStarted;
        lastError = classifyHistoricalUnitError(error);
        if (!lastError.retryable) throw Object.assign(lastError, { fetchProfile: profile });
        const isLast = attempt + 1 >= maxAttempts;
        if (isLast) break;
        profile.retryCount += 1;
        const backoff = Math.min(maxBackoffMs, backoffBaseMs * 2 ** attempt) + Math.floor(random() * 150);
        profile.throttledMs += backoff;
        await delayImpl(backoff);
      }
    }
    if (sourceIndex + 1 < sources.length) profile.retryCount += 1;
  }
  throw Object.assign(new HistoricalUnitError("transient", `Official historical source remained unavailable after ${profile.attempts} attempts: ${lastError?.message ?? "unknown error"}`, { cause: lastError }), { fetchProfile: profile });
}

