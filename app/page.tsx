"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Tab = "overview" | "market" | "events" | "explore" | "rules" | "settings";
type Horizon = 5 | 10 | 20;
type MarketPulse = {
  indexName: string;
  close: number | null;
  change: number | null;
  changePercent: number | null;
  tradingDate: string | null;
  fetchedAt: string;
  status: "official" | "unavailable";
  sourceUrl: string;
};
type Stock = {
  code: string;
  name: string;
  market: "上市" | "上櫃";
  close: number | null;
  change: number | null;
  volume: number | null;
  dataState: "official" | "directory_only";
  sourceUrl: string;
};
type DailyCandidate = Stock & {
  changePercent: number;
  ruleScore: number;
  reasons: string[];
  limitation: string;
};
type CandidateResponse = {
  status: "official" | "unavailable";
  layer: "v1_rule_engine";
  tradingDate: string | null;
  fetchedAt: string;
  candidates: DailyCandidate[];
  disclosure: string;
};
type CloudJob = {
  configured: boolean;
  status: string;
  progress?: number;
  storedRows?: number;
  currentDate?: string | null;
  updatedAt?: string;
  failedUnits?: number;
  startUrl: string;
  retryUrl: string;
};
type ModelHealth = {
  status: string;
  historicalRows: number;
  stockCount: number;
  earliestDate: string | null;
  latestDate: string | null;
  modelRuns: Array<{ horizon: number; status: string; sampleCount: number; calibrationError: number | null }>;
  backfill: null | {
    id: number;
    status: string;
    targetStart: string;
    targetEnd: string;
    cursorDate: string;
    cursorMarket: string;
    processedUnits: number;
    totalUnits: number;
    storedRows: number;
    emptyUnits: number;
    failedUnits: number;
    phase: string;
    estimatedTotalRows: number;
    rowProgress: number;
    lastBatchId: string | null;
    lastBatchRows: number;
    lastCheckpointAt: string | null;
    apiRetryCount: number;
    throttledMs: number;
    openFailures: number;
    progress: number;
    updatedAt: string;
    audits: Array<{ auditType: string; passed: number; blocked: number; violations: number }>;
  };
  runner: null | {
    status: string;
    leaseUntil: string | null;
    lastStartedAt: string | null;
    lastHeartbeatAt: string | null;
    lastFinishedAt: string | null;
    completedBatches: number;
    completedUnits: number;
    activeRuntimeMs: number;
    lastBatchRows: number;
    lastBatchDurationMs: number;
    recentRowsPerSecond: number;
    apiRetryCount: number;
    throttledMs: number;
    networkMs: number;
    parseMs: number;
    dbWriteMs: number;
    workerWaitMs: number;
    rateLimited: number;
    checkpointStatus: string;
    automationEnabled: number;
    schedulerIntervalMinutes: number;
    schedulerLastTriggeredAt: string | null;
    schedulerNextExpectedAt: string | null;
    lastTriggerSource: string;
    schedulerHealthy: boolean;
    lastError: string | null;
  };
  snapshot: null | {
    snapshotVersion: string;
    cutoffDate: string;
    status: string;
    expectedRows: number;
    importedRows: number;
    nextChunk: number;
    totalChunks: number;
    lastError: string | null;
    startedAt: string;
    updatedAt: string;
    completedAt: string | null;
  };
  performance: {
    recentRowsPerSecond: number;
    averageRowsPerSecond: number;
    activeRuntimeMs: number;
    etaSeconds: number | null;
    abnormal: boolean;
    apiRetryCount: number;
    throttledMs: number;
    rateLimited: boolean;
    networkMs: number;
    parseMs: number;
    dbWriteMs: number;
    workerWaitMs: number;
    featureMs: number;
    healthQueryMs: number;
  };
  currentStage: string;
  nextStages: string[];
  policy: { version: string; targetStart: string; universe: string; usesCurrentListings: boolean; featureAvailability: string };
};

const emptyHealth: ModelHealth = {
  status: "not_started", historicalRows: 0, stockCount: 0, earliestDate: null, latestDate: null,
  modelRuns: [], backfill: null, runner: null, snapshot: null,
  performance: { recentRowsPerSecond: 0, averageRowsPerSecond: 0, activeRuntimeMs: 0, etaSeconds: null, abnormal: false, apiRetryCount: 0, throttledMs: 0, rateLimited: false, networkMs: 0, parseMs: 0, dbWriteMs: 0, workerWaitMs: 0, featureMs: 0, healthQueryMs: 0 },
  currentStage: "下載原始行情 → 正規化 → 驗證 → 批次寫入", nextStages: [],
  policy: { version: "pit-v2.2", targetStart: "2010-01-04", universe: "official_full_market_as_of_each_date", usesCurrentListings: false, featureAvailability: "next_calendar_day_00_taipei" },
};

const navItems: { id: Tab; label: string; icon: string }[] = [
  { id: "overview", label: "總覽", icon: "⌂" },
  { id: "market", label: "全市場", icon: "◉" },
  { id: "events", label: "事件", icon: "ϟ" },
  { id: "explore", label: "探險", icon: "↗" },
  { id: "rules", label: "規則", icon: "✓" },
  { id: "settings", label: "設定", icon: "⚙" },
];

const sources = [
  ["TWSE", "臺灣證券交易所", "上市價量、指數、三大法人", "https://openapi.twse.com.tw/"],
  ["TPEx", "證券櫃檯買賣中心", "上櫃價量與櫃買市場資料", "https://www.tpex.org.tw/openapi/"],
  ["MOPS", "公開資訊觀測站", "營收、財報、重大訊息", "https://mops.twse.com.tw/mops/web/index"],
  ["TDCC", "臺灣集中保管結算所", "股權分散與持股級距", "https://www.tdcc.com.tw/portal/zh/smWeb/qryStock"],
];

const number = (value: number | null, digits = 2) =>
  value === null ? "—" : new Intl.NumberFormat("zh-TW", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const volume = (value: number | null) => {
  if (value === null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString("zh-TW");
};
const dateTime = (value?: string | null) => {
  if (!value) return "尚未取得";
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
};
const duration = (seconds: number | null) => {
  if (seconds === null || !Number.isFinite(seconds)) return "計算中";
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days) return `${days} 天 ${hours} 小時`;
  if (hours) return `${hours} 小時 ${minutes} 分`;
  return `${minutes} 分`;
};
const speed = (value: number) => `${value.toLocaleString("zh-TW", { maximumFractionDigits: value >= 100 ? 0 : 1 })} rows/s`;

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>;
}
function Dot({ state }: { state: "ok" | "work" | "lock" }) {
  return <span className={`status-dot ${state}`} aria-hidden="true" />;
}
function Heading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return <div className="section-heading"><span className="section-kicker">{eyebrow}</span><h2>{title}</h2></div>;
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("overview");
  const [market, setMarket] = useState<MarketPulse | null>(null);
  const [marketLoading, setMarketLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedStock, setSelectedStock] = useState<Stock | null>(null);
  const [horizon, setHorizon] = useState<Horizon>(5);
  const [watchlist, setWatchlist] = useState<string[]>(["5274"]);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [candidateData, setCandidateData] = useState<CandidateResponse | null>(null);
  const [candidateLoading, setCandidateLoading] = useState(true);
  const [modelHealth, setModelHealth] = useState<ModelHealth>(emptyHealth);
  const [cloudJob, setCloudJob] = useState<CloudJob | null>(null);
  const [backfillWorking, setBackfillWorking] = useState(false);
  const [backfillError, setBackfillError] = useState("");
  const ownerKey = useRef("");

  useEffect(() => {
    const refresh = async () => {
      try {
        const response = await fetch("/api/cloud-job", { cache: "no-store" });
        setCloudJob(await response.json() as CloudJob);
      } catch { /* Keep the last durable cloud status. */ }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    fetch("/api/market", { cache: "no-store" })
      .then((response) => response.json() as Promise<MarketPulse>)
      .then(setMarket)
      .catch(() => setMarket({ indexName: "發行量加權股價指數", close: null, change: null, changePercent: null, tradingDate: null, fetchedAt: new Date().toISOString(), status: "unavailable", sourceUrl: "https://openapi.twse.com.tw/" }))
      .finally(() => setMarketLoading(false));
  }, []);

  useEffect(() => {
    if (["complete", "blocked_bias_violation"].includes(modelHealth.backfill?.status ?? "")) return;
    const refresh = async () => {
      try {
        const response = await fetch("/api/model-health", { cache: "no-store" });
        if (response.ok) setModelHealth(await response.json() as ModelHealth);
      } catch { /* Keep the last verified state. */ }
    };
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [modelHealth.backfill?.status]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/candidates", { cache: "no-store" });
        setCandidateData(await response.json() as CandidateResponse);
      } catch {
        setCandidateData({ status: "unavailable", layer: "v1_rule_engine", tradingDate: null, fetchedAt: new Date().toISOString(), candidates: [], disclosure: "官方資料不足，因此今日不產生候選。" });
      } finally {
        setCandidateLoading(false);
        try {
          const response = await fetch("/api/model-health", { cache: "no-store" });
          setModelHealth(await response.json() as ModelHealth);
        } catch { /* Keep the explicit zero state. */ }
      }
    })();
  }, []);

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    void (async () => {
      let key = window.localStorage.getItem("wall-explorer-device-key");
      if (!key) {
        key = globalThis.crypto?.randomUUID?.() ?? `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        window.localStorage.setItem("wall-explorer-device-key", key);
      }
      ownerKey.current = key;
      try {
        const response = await fetch(`/api/watchlist?owner=${encodeURIComponent(key)}`, { cache: "no-store" });
        const body = (await response.json()) as { codes?: string[] };
        if (body.codes?.length) setWatchlist(body.codes);
      } catch {
        const local = window.localStorage.getItem("wall-explorer-watchlist");
        if (local) setWatchlist(JSON.parse(local) as string[]);
      }
    })();
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", reducedMotion);
    window.localStorage.setItem("wall-explorer-reduced-motion", String(reducedMotion));
  }, [reducedMotion]);

  const title = useMemo(() => ({
    overview: "今天先看清楚", market: "搜尋全市場", events: "事件雷達",
    explore: "牆外探險", rules: "模型怎麼判斷", settings: "系統與來源",
  })[tab], [tab]);

  const subtitle = ({
    overview: "事實有來源，推論有期限；不知道的地方就留白。",
    market: "代號或公司名稱都可以，資料日期會清楚標示。",
    events: "只有正式日程與第一手公告會列為已確認。",
    explore: "先完成驗證，再談第 1 次牆外探險。",
    rules: "每個結論都要能回到資料、模型與驗證紀錄。",
    settings: "版本、資料來源與裝置體驗都集中在這裡。",
  })[tab];

  async function searchStocks(event?: FormEvent) {
    event?.preventDefault();
    const clean = query.trim();
    if (!clean) return;
    setSearching(true);
    setSubmittedQuery(clean);
    setTab("market");
    try {
      const response = await fetch(`/api/stocks?q=${encodeURIComponent(clean)}`, { cache: "no-store" });
      const body = (await response.json()) as { stocks?: Stock[] };
      setStocks(body.stocks ?? []);
    } catch { setStocks([]); }
    finally { setSearching(false); }
  }

  function toggleWatchlist(code: string) {
    const removing = watchlist.includes(code);
    const next = removing ? watchlist.filter((item) => item !== code) : [...watchlist, code];
    setWatchlist(next);
    window.localStorage.setItem("wall-explorer-watchlist", JSON.stringify(next));
    if (!ownerKey.current) return;
    void fetch("/api/watchlist", {
      method: removing ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: ownerKey.current, code, market: selectedStock?.market ?? "" }),
    }).catch(() => undefined);
  }

  function go(next: Tab) {
    setTab(next);
    window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
  }

  const runBackfill = useCallback(async () => {
    if (backfillWorking) return;
    setBackfillWorking(true);
    setBackfillError("");
    try {
      const started = await fetch("/api/backfill", { method: "POST", cache: "no-store" });
      if (!started.ok) {
        const body = await started.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "回填服務暫時無法使用");
      }
      const response = await fetch("/api/model-health", { cache: "no-store" });
      if (response.ok) setModelHealth(await response.json() as ModelHealth);
    } catch (error) {
      setBackfillError(error instanceof Error ? error.message : "回填服務暫時無法使用");
    } finally {
      setBackfillWorking(false);
    }
  }, [backfillWorking]);

  return (
    <div className="site-frame">
      <header className="topbar">
        <button className="brand-button" onClick={() => go("overview")} aria-label="回到總覽">
          <BrandMark /><span><strong>牆外探險</strong><small>研究站 v2</small></span>
        </button>
        <div className="top-status"><span className="live-dot" />官方資料模式</div>
      </header>

      <main className="page">
        <section className="page-heading">
          <p className="eyebrow">TAIWAN EQUITY RESEARCH</p>
          <h1>{title}</h1><p>{subtitle}</p>
        </section>

        {tab === "overview" && <Overview market={market} loading={marketLoading} query={query} setQuery={setQuery} onSearch={searchStocks} candidates={candidateData} candidateLoading={candidateLoading} health={modelHealth} onSelect={setSelectedStock} />}
        {tab === "market" && <MarketSearch query={query} setQuery={setQuery} onSearch={searchStocks} searching={searching} submitted={submittedQuery} stocks={stocks} onSelect={setSelectedStock} />}
        {tab === "events" && <Events />}
        {tab === "explore" && <Explore candidates={candidateData} candidateLoading={candidateLoading} onSelect={setSelectedStock} />}
        {tab === "rules" && <Rules horizon={horizon} setHorizon={setHorizon} health={modelHealth} cloudJob={cloudJob} backfillWorking={backfillWorking} backfillError={backfillError} onBackfill={runBackfill} />}
        {tab === "settings" && <Settings reducedMotion={reducedMotion} setReducedMotion={setReducedMotion} />}
      </main>

      <nav className="bottom-nav" aria-label="主要導覽">
        {navItems.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => go(item.id)}><span aria-hidden="true">{item.icon}</span><small>{item.label}</small></button>)}
      </nav>

      {selectedStock && <StockSheet stock={selectedStock} horizon={horizon} setHorizon={setHorizon} saved={watchlist.includes(selectedStock.code)} onToggle={() => toggleWatchlist(selectedStock.code)} onClose={() => setSelectedStock(null)} />}
    </div>
  );
}

function Overview({ market, loading, query, setQuery, onSearch, candidates, candidateLoading, health, onSelect }: { market: MarketPulse | null; loading: boolean; query: string; setQuery: (value: string) => void; onSearch: (event?: FormEvent) => void; candidates: CandidateResponse | null; candidateLoading: boolean; health: ModelHealth; onSelect: (stock: Stock) => void }) {
  const positive = (market?.change ?? 0) >= 0;
  const backfill = health.backfill;
  return <div className="stack enter">
    <section className="truth-banner">
      <div className="truth-icon">✓</div><div><strong>第二版正在建立可信資料核心</strong><p>目前只顯示取得成功的官方資料；預測模型尚未通過驗證。</p></div><span className="version-pill">v2 · BUILD</span>
    </section>
    <section className="market-card hero-card">
      <div className="card-topline"><span>臺股加權 · 官方最新日資料</span><a href={market?.sourceUrl ?? "https://openapi.twse.com.tw/"} target="_blank" rel="noreferrer">查看來源 ↗</a></div>
      {loading ? <div className="skeleton-block" /> : market?.status === "official" ? <>
        <div className="market-value-row"><strong>{number(market.close)}</strong><span className={positive ? "up" : "down"}>{positive ? "+" : ""}{number(market.change)} · {positive ? "+" : ""}{number(market.changePercent)}%</span></div>
        <div className="market-meta"><span>交易日 {market.tradingDate}</span><span>取得 {dateTime(market.fetchedAt)}</span></div>
      </> : <div className="empty-inline"><strong>官方資料暫時無法取得</strong><span>不使用舊數字補位，稍後會自動再試。</span></div>}
    </section>
    <form className="search-card" onSubmit={onSearch}>
      <div><span className="section-kicker">快速查詢</span><strong>想研究哪一家公司？</strong></div>
      <label className="search-field"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="輸入 5274 或信驊" inputMode="search" aria-label="股票代號或公司名稱" /><button type="submit">查詢</button></label>
    </form>
    <CandidateBoard data={candidates} loading={candidateLoading} onSelect={onSelect} />
    <section className="section-block">
      <div className="section-heading-row"><Heading eyebrow="研究管線" title="先證明能用，再顯示機率" /><span className="progress-count">{health.historicalRows > 0 ? "2" : "1"} / 4</span></div>
      <div className="pipeline">
        <Pipe state="ok" title="官方資料入口" detail="上市指數與股票搜尋已接入" result="進行中" />
        <Pipe state={health.historicalRows > 0 ? "ok" : "work"} title="v2.2 歷史回填" detail={backfill ? `${backfill.progress.toFixed(2)}% · ${health.historicalRows.toLocaleString("zh-TW")} 筆 · 游標 ${backfill.cursorDate} ${backfill.cursorMarket}` : "逐日讀取當時的官方全市場母體"} result={backfill?.status === "blocked_bias_violation" ? "已阻擋" : health.historicalRows > 0 ? "回填中" : "準備中"} />
        <Pipe state="lock" title="樣本外回測" detail="5／10／20 日分開訓練與驗證" result="鎖定" />
        <Pipe state="lock" title="機率校準" detail="通過後才解鎖研究候選" result="鎖定" />
      </div>
    </section>
    <section className="schedule-strip"><Schedule time="08:00" title="事件雷達" detail="正式日程與公告" /><i /><Schedule time="09:00" title="開盤狀態" detail="僅顯示盤中狀態" /><i /><Schedule time="16:30" title="盤後掃描" detail="完整日資料研究" /></section>
  </div>;
}

function CandidateBoard({ data, loading, onSelect }: { data: CandidateResponse | null; loading: boolean; onSelect: (stock: Stock) => void }) {
  return <section className="section-block candidate-board">
    <div className="section-heading-row"><Heading eyebrow="第一版規則層" title="每日研究候選" /><span className="legacy-pill">V1 規則</span></div>
    {loading ? <div className="candidate-loading"><i /><i /><i /></div> : data?.status === "official" && data.candidates.length ? <>
      <div className="candidate-date">官方交易日 {data.tradingDate} · 最多顯示 5 檔</div>
      <div className="candidate-list">{data.candidates.map((stock) => <button key={`${stock.market}-${stock.code}`} onClick={() => onSelect(stock)}>
        <div className="candidate-rank"><span>{stock.ruleScore}</span><small>規則分</small></div>
        <div className="candidate-name"><span>{stock.code} · {stock.market}</span><strong>{stock.name}</strong><small>{stock.reasons[0]}</small></div>
        <div className="candidate-move"><strong className={stock.changePercent >= 0 ? "up" : "down"}>{stock.changePercent >= 0 ? "+" : ""}{stock.changePercent.toFixed(2)}%</strong><small>{number(stock.close)}</small></div>
      </button>)}</div>
    </> : <div className="empty-inline roomy"><strong>{data?.status === "official" ? "今天沒有股票通過第一版規則" : "官方資料不足，今日不產生候選"}</strong><span>不會用名稱索引或舊行情硬湊推薦。</span></div>}
    <p className="candidate-disclosure">{data?.disclosure ?? "每日候選正在讀取官方資料。"}</p>
  </section>;
}

function Pipe({ state, title, detail, result }: { state: "ok" | "work" | "lock"; title: string; detail: string; result: string }) {
  return <div className={`pipeline-item ${state === "ok" ? "active" : ""}`}><Dot state={state} /><div><strong>{title}</strong><span>{detail}</span></div><b>{result}</b></div>;
}
function Schedule({ time, title, detail }: { time: string; title: string; detail: string }) {
  return <div><span>{time}</span><strong>{title}</strong><small>{detail}</small></div>;
}

function MarketSearch({ query, setQuery, onSearch, searching, submitted, stocks, onSelect }: { query: string; setQuery: (value: string) => void; onSearch: (event?: FormEvent) => void; searching: boolean; submitted: string; stocks: Stock[]; onSelect: (stock: Stock) => void }) {
  return <div className="stack enter">
    <form className="market-search" onSubmit={onSearch}><label><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="股票代號或公司名稱" autoFocus inputMode="search" /></label><button type="submit" disabled={searching}>{searching ? "查詢中" : "搜尋"}</button></form>
    {!submitted && <section className="empty-state"><div className="empty-symbol">5274</div><h2>代號與名稱都找得到</h2><p>例如輸入「5274」或「信驊」。若官方行情暫時失敗，名稱仍會顯示，但價格保持空白。</p></section>}
    {submitted && !searching && <section className="section-block result-block">
      <div className="section-heading-row"><Heading eyebrow="搜尋結果" title={stocks.length ? `找到 ${stocks.length} 筆「${submitted}」` : `找不到「${submitted}」`} /></div>
      {stocks.length ? <div className="stock-list">{stocks.map((stock) => <button className="stock-row" key={`${stock.market}-${stock.code}`} onClick={() => onSelect(stock)}>
        <div className="stock-identity"><span>{stock.code}</span><div><strong>{stock.name}</strong><small>{stock.market} · {stock.dataState === "official" ? "官方行情" : "僅名稱索引"}</small></div></div>
        <div className="stock-quote"><strong>{number(stock.close)}</strong><span className={(stock.change ?? 0) >= 0 ? "up" : "down"}>{stock.change === null ? "等待行情" : `${stock.change >= 0 ? "+" : ""}${number(stock.change)}`}</span></div><span className="chevron">›</span>
      </button>)}</div> : <div className="empty-inline roomy"><strong>沒有符合的公司</strong><span>請檢查代號或名稱；系統不會猜測公司身分。</span></div>}
    </section>}
  </div>;
}

function Events() {
  return <div className="stack enter">
    <section className="radar-card"><div className="radar-visual"><i /><i /><i /><b /></div><div><span className="section-kicker">NEXT CHECK · 08:00</span><h2>已確認事件才進雷達</h2><p>目前沒有取得可由第一手來源確認、且需要特別提醒的事件。</p></div></section>
    <section className="section-block"><Heading eyebrow="判定層級" title="消息不再混成一團" /><div className="event-levels">
      <EventLevel kind="confirmed" badge="已確認" title="正式日程、逐字稿或公司公告" detail="可以作為事件事實使用，並附原始連結。" />
      <EventLevel kind="pending" badge="待證實" title="媒體報導但尚無第一手文件" detail="只列為線索，不進入模型的重要事件標記。" />
      <EventLevel kind="ignored" badge="不採用" title="轉傳、匿名消息或無法追溯內容" detail="不顯示，也不作為股票判斷依據。" />
    </div></section>
  </div>;
}
function EventLevel({ kind, badge, title, detail }: { kind: string; badge: string; title: string; detail: string }) {
  return <div><span className={`event-badge ${kind}`}>{badge}</span><strong>{title}</strong><p>{detail}</p></div>;
}

function Explore({ candidates, candidateLoading, onSelect }: { candidates: CandidateResponse | null; candidateLoading: boolean; onSelect: (stock: Stock) => void }) {
  return <div className="stack enter">
    <CandidateBoard data={candidates} loading={candidateLoading} onSelect={onSelect} />
    <section className="locked-card"><div className="lock-orbit"><span>1</span></div><span className="section-kicker">第 1 次牆外探險</span><h2>還沒到出發時間</h2><p>長期資料、樣本外回測與機率校準尚未全部通過。系統不會為了湊候選而硬推股票。</p>
      <div className="gate-list"><Gate state="work" name="官方資料覆蓋" value="回填中" /><Gate state="lock" name="樣本外表現" value="未驗證" /><Gate state="lock" name="成本後結果" value="未驗證" /><Gate state="lock" name="機率校準" value="未驗證" /></div>
    </section><section className="note-card"><span>!</span><p><strong>系統只提出研究候選。</strong>不保證獲利、不自動下單；由你確認後才建立探險紀錄。</p></section>
  </div>;
}
function Gate({ state, name, value }: { state: "work" | "lock"; name: string; value: string }) { return <div><Dot state={state} /><span>{name}</span><b>{value}</b></div>; }

function Rules({ horizon, setHorizon, health, cloudJob, backfillWorking, backfillError, onBackfill }: { horizon: Horizon; setHorizon: (value: Horizon) => void; health: ModelHealth; cloudJob: CloudJob | null; backfillWorking: boolean; backfillError: string; onBackfill: () => void }) {
  const metrics = [["上漲機率", `未來 ${horizon} 日報酬大於 0 的校準機率`], ["超額報酬", "股票報酬減去對應市場指數報酬"], ["風險回落", "95% 風險情境的期間內可能回落"], ["不確定程度", "模型分歧、資料缺口與校準誤差"]];
  const backfill = health.backfill;
  const survivorship = backfill?.audits.find((audit) => audit.auditType === "survivorship");
  const lookahead = backfill?.audits.find((audit) => audit.auditType === "lookahead");
  const blocked = backfill?.status === "blocked_bias_violation";
  const finished = backfill?.status === "complete";
  const runnerActive = health.runner?.status === "running";
  const automatic = Boolean(health.runner?.schedulerHealthy);
  const snapshot = health.snapshot;
  const snapshotProgress = snapshot ? Math.min(100, snapshot.importedRows / Math.max(1, snapshot.expectedRows) * 100) : 0;
  const perf = health.performance;
  const checkpoint = health.runner?.checkpointStatus ?? (backfill?.lastCheckpointAt ? "saved" : "not_started");
  return <div className="stack enter">
    <section className="definition-card"><span className="section-kicker">核心界線</span><h2>官方證明現在，模型推論未來</h2><div className="definition-flow"><Definition no="01" title="官方事實" detail="價量、法人、營收、財報與事件" /><i>→</i><Definition no="02" title="模型推論" detail="學習歷史關係，輸出條件機率" /><i>→</i><Definition no="03" title="樣本外驗證" detail="未見資料、成本與機率校準" /></div></section>
    <section className="section-block backfill-card">
      <div className="section-heading-row"><Heading eyebrow="v2.2 · 歷史回填" title="先鎖死兩種偏差" /><span className={`health-pill ${blocked ? "danger" : ""}`}>{blocked ? "已阻擋" : finished ? "回填完成" : backfill ? "回填中" : "準備開始"}</span></div>
      <p className="backfill-intro">主路徑已改為獨立伺服器Job建立Historical DB Snapshot，Web App只驗證並匯入Snapshot；完整逐日重建保留為備援，不再依賴手機或瀏覽器前景。</p>
      <div className={`snapshot-route ${snapshot?.status === "complete" ? "snapshot-ready" : ""}`}><div><strong>Snapshot優先</strong><span>{snapshot?.status === "complete" ? `已驗證 ${snapshot.snapshotVersion}，截止 ${snapshot.cutoffDate}` : snapshot?.status === "importing" ? `伺服器匯入中 ${snapshotProgress.toFixed(1)}%` : snapshot?.status === "error" ? "Snapshot驗證或匯入失敗，未切換研究資料" : "等待獨立Builder發布首份完整Snapshot"}</span><small>{snapshot ? `${snapshot.importedRows.toLocaleString("zh-TW")} / ${snapshot.expectedRows.toLocaleString("zh-TW")} 筆 · chunk ${snapshot.nextChunk}/${snapshot.totalChunks}` : "現有資料與checkpoint保持不動"}</small></div><b>{snapshot?.status === "complete" ? "READY" : snapshot?.status === "error" ? "BLOCKED" : "SERVER JOB"}</b></div>
      <div className="bias-guards">
        <div><span className={survivorship?.blocked || survivorship?.violations ? "guard-bad" : "guard-ok"}>{survivorship?.blocked || survivorship?.violations ? "阻擋" : "硬規則"}</span><strong>1. 生存者偏差</strong><p>當日有出現在官方市場表的證券就保存；日後下市、下櫃也不刪除。現在的股票清單完全不參與歷史母體。</p><small>{survivorship ? `通過 ${survivorship.passed} 次 · 違規 ${survivorship.violations}` : "等待第一批官方資料稽核"}</small></div>
        <div><span className={lookahead?.blocked || lookahead?.violations ? "guard-bad" : "guard-ok"}>{lookahead?.blocked || lookahead?.violations ? "阻擋" : "硬規則"}</span><strong>2. 前視偏見</strong><p>盤後資料最早到下一日 00:00（台北時間）才能當特徵；官方回傳日期和請求日期不一致時整批拒收。</p><small>{lookahead ? `通過 ${lookahead.passed} 次 · 違規 ${lookahead.violations}` : "等待第一批官方資料稽核"}</small></div>
      </div>
      {perf.abnormal && <div className="backfill-warning"><strong>回填速度異常</strong><span>依最近速度估算，剩餘時間超過 24 小時。系統仍會從 checkpoint 續跑。</span></div>}
      <div className="backfill-progress"><div><span>實際回填進度</span><b>{backfill ? `${backfill.progress.toFixed(2)}%` : "0.00%"}</b></div><i><span style={{ width: `${backfill?.progress ?? 0}%` }} /></i><div className="backfill-meta"><span>{backfill ? `${backfill.storedRows.toLocaleString("zh-TW")} / ${backfill.estimatedTotalRows.toLocaleString("zh-TW")} 筆（估）` : "0 / 計算中"}</span><span>{backfill ? `市場單位 ${backfill.processedUnits.toLocaleString("zh-TW")} / ${backfill.totalUnits.toLocaleString("zh-TW")}` : "尚未建立工作"}</span></div></div>
      <div className="backfill-telemetry">
        <div><span>當前交易日</span><b>{backfill?.cursorDate ?? "—"}</b><small>{backfill?.cursorMarket ?? "—"}</small></div>
        <div><span>當前階段</span><b>原始行情</b><small>下載・正規化・驗證・寫入</small></div>
        <div><span>最近速度</span><b>{speed(perf.recentRowsPerSecond)}</b><small>上一個伺服器批次</small></div>
        <div><span>執行平均</span><b>{speed(perf.averageRowsPerSecond)}</b><small>只計背景運算時間</small></div>
        <div><span>已執行</span><b>{duration(perf.activeRuntimeMs / 1_000)}</b><small>累計有效執行時間</small></div>
        <div><span>ETA</span><b>{duration(perf.etaSeconds)}</b><small>依最近有效速度估算</small></div>
        <div><span>API retry</span><b>{perf.apiRetryCount.toLocaleString("zh-TW")}</b><small>{perf.rateLimited ? "官方限流中" : "目前未限流"}</small></div>
        <div><span>Checkpoint</span><b>{checkpoint === "saved" ? "已保存" : checkpoint === "writing" ? "寫入中" : checkpoint === "error" ? "異常" : "等待"}</b><small>{backfill?.lastCheckpointAt ? dateTime(backfill.lastCheckpointAt) : "尚未建立"}</small></div>
      </div>
      <div className={`backfill-auto ${runnerActive ? "runner-active" : ""}`}><div><strong>完整重建備援</strong><span>{runnerActive ? "伺服器批次執行中；關閉網站不影響本批" : "逐日官方重建與checkpoint仍保留，但不再由瀏覽器自動啟動"}</span><small>{automatic ? `偵測到排程心跳 ${dateTime(health.runner?.schedulerLastTriggeredAt)}` : "Web Worker／Service Worker／Wake Lock都不是必要條件"}</small></div><i className="runner-pulse" aria-hidden="true" /></div>
      <div className="cloud-job-card"><div><strong>GitHub Actions 雲端 Snapshot Job</strong><span>{cloudJob?.configured ? `${cloudJob.status} · ${(cloudJob.progress ?? 0).toFixed(2)}% · ${(cloudJob.storedRows ?? 152052).toLocaleString("zh-TW")} 筆` : "等待 Cloudflare R2 與 GitHub Secrets 設定"}</span><small>{cloudJob?.updatedAt ? `最近更新 ${dateTime(cloudJob.updatedAt)} · 游標 ${cloudJob.currentDate ?? "—"}` : "手機關閉後仍由 GitHub Actions 執行；每批將 checkpoint 寫入 R2"}</small></div><b>{cloudJob?.status === "complete" ? "READY" : cloudJob?.configured ? "CLOUD" : "SETUP"}</b></div>
      <a className="backfill-button cloud-action" href={cloudJob?.startUrl ?? "https://github.com/stevenliang0815-code/wall-explorer/actions/workflows/historical-backfill.yml"} target="_blank" rel="noreferrer">{cloudJob?.status === "retrying" ? "開啟 GitHub Actions 重試／續跑" : "開啟 GitHub Actions 啟動 Snapshot Job"}</a>
      <button className="backfill-button" onClick={onBackfill} disabled={backfillWorking || runnerActive || blocked || finished}>{backfillWorking ? "正在交給伺服器…" : runnerActive ? "完整重建批次執行中" : blocked ? "偏差稽核未通過，已停止" : finished ? "完整重建已完成" : backfill?.status === "complete_with_gaps" ? "重試完整重建缺口" : "手動執行一批完整重建（備援）"}</button>
      {backfillError && <p className="backfill-error">本次沒有寫入：{backfillError}</p>}
      <p className="backfill-disclosure">獨立Snapshot Builder以官方逐日全市場資料產生壓縮SQLite、分塊匯入檔與SHA-256 manifest；伺服器匯入支援chunk checkpoint及UPSERT。Snapshot完成後只走每日增量；下載失敗不會當成休市日，也不會在原始回填階段計算特徵、標籤或模型。</p>
    </section>
    <section className="section-block"><Heading eyebrow="三個週期" title="每個期限獨立判斷" /><HorizonTabs horizon={horizon} setHorizon={setHorizon} /><div className="metric-grid">{metrics.map(([name, detail]) => <div className="metric-definition" key={name}><span>—</span><strong>{name}</strong><p>{detail}</p><small>等待驗證</small></div>)}</div></section>
    <section className="section-block"><div className="section-heading-row"><Heading eyebrow="模型健康" title="能不能信，要看這裡" /><span className="health-pill">{health.modelRuns.length ? "已有測試" : "尚未評分"}</span></div><div className="health-list"><Health name="已保存官方歷史資料" value={`${health.historicalRows.toLocaleString("zh-TW")} 筆`} /><Health name="歷史曾出現證券" value={`${health.stockCount.toLocaleString("zh-TW")} 檔`} /><Health name="目前日期範圍" value={health.earliestDate && health.latestDate ? `${health.earliestDate}～${health.latestDate}` : "尚無資料"} /><Health name="未修復下載缺口" value={`${backfill?.openFailures ?? 0} 個市場日`} /><Health name="樣本外回測" value={health.modelRuns.length ? `${health.modelRuns.length} 組紀錄` : "尚未執行"} /><Health name="機率校準" value={health.modelRuns.some((run) => run.calibrationError !== null) ? "已有結果" : "尚未執行"} /></div><p className="health-disclosure">這裡直接讀取資料庫紀錄；0 筆就是 0 筆，不使用假進度。</p></section>
  </div>;
}
function Definition({ no, title, detail }: { no: string; title: string; detail: string }) { return <div><span>{no}</span><strong>{title}</strong><p>{detail}</p></div>; }
function Health({ name, value }: { name: string; value: string }) { return <div><span>{name}</span><b>{value}</b></div>; }
function HorizonTabs({ horizon, setHorizon, compact = false }: { horizon: Horizon; setHorizon: (value: Horizon) => void; compact?: boolean }) { return <div className={`horizon-tabs ${compact ? "compact" : ""}`}>{([5, 10, 20] as Horizon[]).map((days) => <button key={days} className={horizon === days ? "active" : ""} onClick={() => setHorizon(days)}>{days} 日</button>)}</div>; }

function Settings({ reducedMotion, setReducedMotion }: { reducedMotion: boolean; setReducedMotion: (value: boolean) => void }) {
  return <div className="stack enter">
    <section className="version-card"><div><BrandMark /><span><small>目前版本</small><strong>第二版 · 歷史回填</strong></span></div><span className="version-pill">v2.2</span><p>第二版使用獨立專案，不會覆蓋第一版。v2.2 正在建立逐日、時間點一致的官方歷史資料庫。</p></section>
    <section className="section-block settings-block"><div className="setting-row"><div><strong>降低動畫</strong><span>裝置較慢時可減少轉場效果</span></div><button className={`switch ${reducedMotion ? "on" : ""}`} onClick={() => setReducedMotion(!reducedMotion)} role="switch" aria-checked={reducedMotion}><i /></button></div><div className="setting-row static"><div><strong>畫面方向</strong><span>直式優先，橫式仍可閱讀</span></div><b>直式</b></div><div className="setting-row static"><div><strong>研究模式</strong><span>不串接券商、不自動下單</span></div><b>已鎖定</b></div></section>
    <section className="section-block"><Heading eyebrow="官方來源" title="每筆資料都能往回查" /><div className="source-list">{sources.map(([short, name, detail, href]) => <a href={href} target="_blank" rel="noreferrer" key={short}><span>{short}</span><div><strong>{name}</strong><small>{detail}</small></div><b>↗</b></a>)}</div></section>
    <section className="note-card neutral"><span>i</span><p>這是研究工具，不是報明牌機器。沒有足夠證據時，答案就是「不知道」。</p></section>
  </div>;
}

function StockSheet({ stock, horizon, setHorizon, saved, onToggle, onClose }: { stock: Stock; horizon: Horizon; setHorizon: (value: Horizon) => void; saved: boolean; onToggle: () => void; onClose: () => void }) {
  return <div className="sheet-backdrop" onClick={onClose}><section className="stock-sheet" role="dialog" aria-modal="true" aria-label={`${stock.name}研究資料`} onClick={(event) => event.stopPropagation()}><div className="sheet-handle" /><button className="sheet-close" onClick={onClose} aria-label="關閉">×</button>
    <div className="sheet-title"><div><span>{stock.market} · {stock.code}</span><h2>{stock.name}</h2></div><button className={`watch-button ${saved ? "saved" : ""}`} onClick={onToggle}>{saved ? "已觀察" : "+ 觀察"}</button></div>
    <div className="fact-quote"><div><span>官方最新收盤</span><strong>{number(stock.close)}</strong></div><div><span>漲跌</span><strong className={(stock.change ?? 0) >= 0 ? "up" : "down"}>{stock.change === null ? "—" : `${stock.change >= 0 ? "+" : ""}${number(stock.change)}`}</strong></div><div><span>成交量</span><strong>{volume(stock.volume)}</strong></div></div>
    <a className="source-link" href={stock.sourceUrl} target="_blank" rel="noreferrer">官方資料來源 ↗</a><div className="sheet-divider" /><div className="sheet-section-title"><span>模型推論</span><small>尚未通過樣本外驗證</small></div><HorizonTabs horizon={horizon} setHorizon={setHorizon} compact />
    <div className="locked-metrics">{[["上漲機率", "—"], ["相對大盤超額報酬", "—"], ["95% 風險回落", "—"], ["不確定程度", "資料不足"]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><div className="honesty-note">資料或回測未達門檻，因此不產生預測數字。</div>
  </section></div>;
}
