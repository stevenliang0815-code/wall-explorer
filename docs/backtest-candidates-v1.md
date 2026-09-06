# Backtest Strategy Candidates v1（研究用）

狀態：experimental / baseline，productionEligible=false。這三個策略只在離線研究引擎中執行，沒有接入 Web App 正式推薦。此版本建立介面、訊號、可重現回測；沒有做參數最佳化，也沒有宣稱哪個策略具有樣本外價值。

## 固定比較設計

策略介面位於 lib/backtest/strategies.mjs：id、status、productionEligible、generate(asOfFeatures, parameters)。三個版本分別為 momentum_v1、trend_momentum_v1、trend_momentum_liquidity_v1。generate 只接收訊號當日以前的特徵，沒有未來價格或完整資料集的引用。

所有參數集中於 DEFAULT_PARAMETERS；修改參數應指定新的 version。預設 momentum 60 日、均線 60/120 日、平均成交金額 20 日、選共用 universe 的前 10%（向上取整），亦可配置前 N 名。同分按 market:code 排序。少於名額時只買符合資格者。

A：60 日價格報酬 > 0，依報酬排名。B：加上 Close > MA60 > MA120。C：在 B 上加上 20 日平均成交金額門檻。三者共用當日可交易普通股與完整 120 日資料的基本 universe；缺價格、缺成交金額、交易中斷造成 lookback 不完整者不補值、不納入。

三者共用的基本低流動性排除，預設去掉平均成交金額最低 10%；C 的額外門檻預設為共用 universe 第 30 百分位。門檻按當日橫斷面計算、可配置，沒有固定任意金額。此為固定研究假設，未經調參挑选。C 額外篩選前後數量與當日實際金額門檻均列入 signals.diagnostics。C 的可投資子集合不同是實驗變量，共用的基本 universe、期間與成本完全一致。

每週最後一個交易日收盤計算 entry/exit；股票跌出規則或排名時於下一次週調倉退出。均線／momentum 條件不是盤中停損。起始日前一日若為週末交易日，可形成起始日開盤訂單；否則持現金等待第一個週訊號。最後測試日不產生無法成交的訂單。

Day T 完整收盤後計算，Day T+1 開盤成交。使用交易所預先已知的 session calendar 判斷週末，不讀未來行情。禁止把事後調整價或修訂資料冒充當時可得資料。

等權、只做多、允許小數股的 baseline；有意保留小數股以比較訊號，不代表符合真實整股／零股撮合。下一日無法交易時不選替代股；既有停牌部位保留並要求明確估值。交易成本：買賣手續費各 0.1425%、賣出稅 0.3%、買賣滑價各 0.1%。這些是固定模擬假設，並非已確認的券商費率；沒有最小手續費、市場衝擊、漲跌停或成交量參與率模型，不能作正式實盤可成交性結論。

## 輸入資料契約 pit_daily_v1

JSON 最外層包含 schemaVersion、datasetVersion、startDate、endDate、split、sessions、bars、benchmark、provenance。sessions 為排序、不重複的交易所交易日；包括足够 warmup、測試期間，以及可用時測試日後的交易日供週界識別。

每筆 bars 必填 date、market（TWSE/TPEX）、code、securityType（ordinary_equity 才可進 universe）、tradable（歷史當日事實）、open、close、tradeValue（原始當日成交金額）、splitRatio（無拆併股時 1）、dividend（無股息時 0）。同市場／代碼／日期不得重複。價格為原始未事後調整價；訊號用截至 T 已發生拆併股做局部調整，報酬定義為價格 momentum，股息進入投資組合收益。

dividend 為事件日按拆股前持股的每股入帳金額；splitRatio 之後調整股數與歷史價格。這是事件日立即入帳的簡化基準，實際付息日期與股息再投資延遲需由資料供應端明確處理。不得直接將事後調整收盤價與這些事件重複計算。

下市必須提供 terminal settlement（settlement 金額/當日每股、tradable=false，可為 0），系統依該金額結算並記錄損失。持股若缺當日資料／估值，整次回測報錯，不能默默消失。沒有持倉且缺資料的標的直接不納入。資料必須包含歷史已退市、改名與停牌標的；不能由目前股票名單反推歷史 universe。

provenance 必須有 pointInTime=true、corporateActionsComplete=true、delistingsComplete=true，並應附來源與校驗依據。這些欄位是資料交付聲明，程式能檢查格式與一致性，但不能單凭旗標證明資料來源無偏差。

benchmark 必填 name、totalReturn=true，以及完整測試日的 bars（date/open/close），代表可比較的總報酬單位序列。基準於測試第一日開盤買入並持有，扣相同買入手續費／滑價；期末不強制出售。大盤總報酬序列必須由經驗證資料供應，不以股票平均值假冒大盤。

## 執行與輸出

`npm run backtest:test`

`npm run backtest:run -- PIT_DATA.json PARAMETERS.json NEW_REPORT.json`

不另指定參數時可用 `-` 代替 PARAMETERS.json。報告檔使用 exclusive create，已存在時停止，避免覆寫研究紀錄。省略輸出路徑則輸出 JSON 到 stdout。

同一次 runComparison 同時跑三策略並產生共同 benchmark，包含引擎版本、資料版本／雜湊、完整参数與雜湊、測試期間／split、每個策略的訊號及流動性統計、equityCurve、tradeLog、closedTrades、openPositions。

績效欄位：CAGR（252 sessions 年化）、cumulativeReturn、maxDrawdown（負數，包含初始資金）、Sharpe（每日報酬樣本標準差）、Sortino（所有日期下行差平方平均）、volatility、winRate、profitFactor、turnover、tradeCount、averageHoldingPeriod。風險免費利率預設 0；零分母指標回傳 null，不假造無限大績效。tradeCount/winRate/profitFactor/持有期以 FIFO 已平倉配對 lot 為單位，包含手續費、滑價、股息及下市結算；openPositions 未平倉損益仍納入 NAV，但不當成已平倉勝率。turnover 為總買賣成交額 / (2 × 平均 NAV)，未年化。期末按收盤價評價，不強制平倉。

## 本輪驗證與下一步

已用人工可控合成資料驗證重現性、未來資料擾動不改變過去結果、次日成交、資料不足／非普通股排除、共同 universe、分層規則、交易費用、拆股、股息、下市歸零及拒絕未知持股估值。這些是引擎測試，不是真實績效比較。

正式研究比較仍需完整歷史 universe、公司行動、下市事件與總報酬 benchmark 資料。現在 operational 的 300 日價量窗口與 snapshot checksum 不足以證明以上資料完整，禁止自行標記真實資料通過。

固定參數先登記，切分訓練／樣本外日期且在看到樣本外結果前鎖定。只在同一份經稽核資料、同一區間與同一成本下跑 A/B/C，報告相對大盤與層級增量；不得根據單一短區間宣布普遍優勢。下一交易日 operational 驗收與此研究引擎分開追蹤，正式選股推薦接線仍需另行通過驗收。
