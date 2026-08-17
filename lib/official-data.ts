export const TWSE_INDEX_URL = "https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX";
export const TWSE_STOCK_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
export const TPEX_STOCK_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes";

type Row = Record<string, unknown>;
export type NormalizedStock = {
  code: string; name: string; market: "上市" | "上櫃"; close: number | null;
  change: number | null; volume: number | null; open?: number | null; high?: number | null;
  low?: number | null; tradeValue?: number | null; dataState: "official" | "directory_only"; sourceUrl: string;
};

export type DailyCandidate = NormalizedStock & {
  changePercent: number;
  ruleScore: number;
  reasons: string[];
  limitation: string;
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
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "WallExplorerV2/2.0" }, signal: AbortSignal.timeout(3500), cache: "no-store" });
  if (!response.ok) throw new Error(`Official source returned ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error("Official source returned an unexpected shape");
  return body as Row[];
}

function twse(row: Row): NormalizedStock | null {
  const code = text(row, "Code", "證券代號", "股票代號");
  const name = text(row, "Name", "證券名稱", "股票名稱");
  if (!code || !name) return null;
  return { code, name, market: "上市", close: numeric(text(row, "ClosingPrice", "收盤價")), change: numeric(text(row, "Change", "漲跌價差")), volume: numeric(text(row, "TradeVolume", "成交股數")), open: numeric(text(row, "OpeningPrice", "開盤價")), high: numeric(text(row, "HighestPrice", "最高價")), low: numeric(text(row, "LowestPrice", "最低價")), tradeValue: numeric(text(row, "TradeValue", "成交金額")), dataState: "official", sourceUrl: TWSE_STOCK_URL };
}

function tpex(row: Row): NormalizedStock | null {
  const code = text(row, "SecuritiesCompanyCode", "Code", "證券代號", "股票代號");
  const name = text(row, "CompanyName", "Name", "證券名稱", "股票名稱");
  if (!code || !name) return null;
  return { code, name, market: "上櫃", close: numeric(text(row, "Close", "ClosingPrice", "收盤價")), change: numeric(text(row, "Change", "漲跌價差")), volume: numeric(text(row, "TradingShares", "TradeVolume", "成交股數")), open: numeric(text(row, "Open", "OpeningPrice", "開盤價")), high: numeric(text(row, "High", "HighestPrice", "最高價")), low: numeric(text(row, "Low", "LowestPrice", "最低價")), tradeValue: numeric(text(row, "TransactionAmount", "TradeValue", "成交金額")), dataState: "official", sourceUrl: TPEX_STOCK_URL };
}

export async function fetchOfficialStocks() {
  const results = await Promise.allSettled([officialJson(TWSE_STOCK_URL), officialJson(TPEX_STOCK_URL)]);
  const normalized: NormalizedStock[] = [];
  if (results[0].status === "fulfilled") for (const row of results[0].value) { const value = twse(row); if (value) normalized.push(value); }
  if (results[1].status === "fulfilled") for (const row of results[1].value) { const value = tpex(row); if (value) normalized.push(value); }
  if (!normalized.length) throw new Error("Official stock sources are unavailable");
  return normalized;
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
  let normalized: NormalizedStock[] = [];
  try { normalized = await fetchOfficialStocks(); } catch { normalized = []; }
  const clean = query.trim().toLocaleLowerCase("zh-TW");
  const live = normalized.filter((item) => item.code.includes(clean) || item.name.toLocaleLowerCase("zh-TW").includes(clean));
  const liveCodes = new Set(live.map((item) => `${item.market}-${item.code}`));
  const fallback = directory.filter((item) => (item.code.includes(clean) || item.name.includes(clean)) && !liveCodes.has(`${item.market}-${item.code}`));
  return [...live, ...fallback].sort((a, b) => a.code.localeCompare(b.code)).slice(0, 30);
}

export async function fetchDailyCandidates(): Promise<DailyCandidate[]> {
  const stocks = await fetchOfficialStocks();
  return rankDailyCandidates(stocks);
}

export function rankDailyCandidates(stocks: NormalizedStock[]): DailyCandidate[] {
  return stocks
    .filter((stock) => /^\d{4}$/.test(stock.code) && stock.close !== null && stock.change !== null && stock.volume !== null)
    .map((stock) => {
      const previous = stock.close! - stock.change!;
      const changePercent = previous > 0 ? stock.change! / previous * 100 : 0;
      const liquidity = Math.max(0, Math.min(35, (Math.log10(Math.max(stock.volume!, 1)) - 4) / 4 * 35));
      const momentum = Math.max(0, Math.min(35, changePercent / 5.5 * 35));
      const heatControl = Math.max(0, 20 - Math.abs(changePercent - 2) * 4);
      const ruleScore = Math.round(Math.max(0, Math.min(100, liquidity + momentum + heatControl + 10)));
      const reasons = [
        changePercent >= .5 && changePercent <= 4 ? "當日價格動能為正且未超過規則上限" : "當日價格動能通過最低條件",
        stock.volume! >= 1_000_000 ? "成交量超過 100 萬股" : "成交量通過流動性門檻",
        "代號與行情均由官方市場資料確認",
      ];
      return { ...stock, changePercent, ruleScore, reasons, limitation: "只使用當日價量的第一版規則；未使用歷史模型，不代表未來上漲機率。" };
    })
    .filter((stock) => stock.changePercent >= .5 && stock.changePercent <= 5.5 && stock.volume! >= 300_000 && stock.ruleScore >= 55)
    .sort((a, b) => b.ruleScore - a.ruleScore || b.volume! - a.volume!)
    .slice(0, 5);
}

function rocDateToIso(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 7) return value || null;
  return `${Number(digits.slice(0, 3)) + 1911}-${digits.slice(3, 5)}-${digits.slice(5, 7)}`;
}
