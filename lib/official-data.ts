export const TWSE_INDEX_URL = "https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX";
export const TWSE_STOCK_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
export const TPEX_STOCK_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes";

type Row = Record<string, unknown>;
export type NormalizedStock = {
  code: string; name: string; market: "上市" | "上櫃"; close: number | null;
  change: number | null; volume: number | null; dataState: "official" | "directory_only"; sourceUrl: string;
};

const directory: NormalizedStock[] = [
  { code: "2330", name: "台積電", market: "上市", close: null, change: null, volume: null, dataState: "directory_only", sourceUrl: "https://openapi.twse.com.tw/" },
  { code: "2317", name: "鴻海", market: "上市", close: null, change: null, volume: null, dataState: "directory_only", sourceUrl: "https://openapi.twse.com.tw/" },
  { code: "2454", name: "聯發科", market: "上市", close: null, change: null, volume: null, dataState: "directory_only", sourceUrl: "https://openapi.twse.com.tw/" },
  { code: "3008", name: "大立光", market: "上市", close: null, change: null, volume: null, dataState: "directory_only", sourceUrl: "https://openapi.twse.com.tw/" },
  { code: "3013", name: "晟銘電", market: "上市", close: null, change: null, volume: null, dataState: "directory_only", sourceUrl: "https://openapi.twse.com.tw/" },
  { code: "5274", name: "信驊", market: "上櫃", close: null, change: null, volume: null, dataState: "directory_only", sourceUrl: "https://www.tpex.org.tw/openapi/" },
  { code: "5483", name: "中美晶", market: "上櫃", close: null, change: null, volume: null, dataState: "directory_only", sourceUrl: "https://www.tpex.org.tw/openapi/" },
  { code: "6488", name: "環球晶", market: "上櫃", close: null, change: null, volume: null, dataState: "directory_only", sourceUrl: "https://www.tpex.org.tw/openapi/" },
];

function text(row: Row, ...keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

export function numeric(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const clean = String(value).replace(/,/g, "").replace(/^[+]/, "").trim();
  if (!clean || clean === "--" || clean === "---" || clean === "-" || clean === "X") return null;
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : null;
}

async function officialJson(url: string): Promise<Row[]> {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "WallExplorerV2/2.0" }, signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!response.ok) throw new Error(`Official source returned ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error("Official source returned an unexpected shape");
  return body as Row[];
}

function twse(row: Row): NormalizedStock | null {
  const code = text(row, "Code", "證券代號", "股票代號");
  const name = text(row, "Name", "證券名稱", "股票名稱");
  if (!code || !name) return null;
  return { code, name, market: "上市", close: numeric(text(row, "ClosingPrice", "收盤價")), change: numeric(text(row, "Change", "漲跌價差")), volume: numeric(text(row, "TradeVolume", "成交股數")), dataState: "official", sourceUrl: TWSE_STOCK_URL };
}

function tpex(row: Row): NormalizedStock | null {
  const code = text(row, "SecuritiesCompanyCode", "Code", "證券代號", "股票代號");
  const name = text(row, "CompanyName", "Name", "證券名稱", "股票名稱");
  if (!code || !name) return null;
  return { code, name, market: "上櫃", close: numeric(text(row, "Close", "ClosingPrice", "收盤價")), change: numeric(text(row, "Change", "漲跌價差")), volume: numeric(text(row, "TradingShares", "TradeVolume", "成交股數")), dataState: "official", sourceUrl: TPEX_STOCK_URL };
}

export async function fetchMarketPulse() {
  const rows = await officialJson(TWSE_INDEX_URL);
  const row = rows.find((item) => text(item, "指數", "Index") === "發行量加權股價指數");
  if (!row) throw new Error("TAIEX row is missing");
  const sign = text(row, "漲跌", "Direction") === "-" ? -1 : 1;
  const rawChange = numeric(text(row, "漲跌點數", "Change"));
  const rawPercent = numeric(text(row, "漲跌百分比", "ChangePercent"));
  return { indexName: "發行量加權股價指數", close: numeric(text(row, "收盤指數", "ClosingIndex")), change: rawChange === null ? null : sign * Math.abs(rawChange), changePercent: rawPercent === null ? null : sign * Math.abs(rawPercent), tradingDate: rocDateToIso(text(row, "日期", "Date")), fetchedAt: new Date().toISOString(), status: "official" as const, sourceUrl: TWSE_INDEX_URL };
}

export async function searchOfficialStocks(query: string) {
  const results = await Promise.allSettled([officialJson(TWSE_STOCK_URL), officialJson(TPEX_STOCK_URL)]);
  const normalized: NormalizedStock[] = [];
  if (results[0].status === "fulfilled") for (const row of results[0].value) { const value = twse(row); if (value) normalized.push(value); }
  if (results[1].status === "fulfilled") for (const row of results[1].value) { const value = tpex(row); if (value) normalized.push(value); }
  const clean = query.trim().toLocaleLowerCase("zh-TW");
  const live = normalized.filter((item) => item.code.includes(clean) || item.name.toLocaleLowerCase("zh-TW").includes(clean));
  const liveCodes = new Set(live.map((item) => `${item.market}-${item.code}`));
  const fallback = directory.filter((item) => (item.code.includes(clean) || item.name.includes(clean)) && !liveCodes.has(`${item.market}-${item.code}`));
  return [...live, ...fallback].sort((a, b) => a.code.localeCompare(b.code)).slice(0, 30);
}

function rocDateToIso(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 7) return value || null;
  return `${Number(digits.slice(0, 3)) + 1911}-${digits.slice(3, 5)}-${digits.slice(5, 7)}`;
}
