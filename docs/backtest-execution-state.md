# 執行狀態：策略候選第一階段

日期：2026-09-06。使用者最新指示：開始三個 experimental / baseline 策略的 interface、signal generation、可重現 backtest；完成後才比較結果，不作正式選股推薦，也不做參數最佳化。

## 完成內容與決策

- strategy interface 與三個 versioned 策略建立；無正式推薦入口引用。
- 參數集中，固定 60/60/120/20 日、前 10%、每週調整；共同低流動性去掉最低 10%，C 額外門檻為基本 universe 第 30 百分位，門檻為固定研究假設。共同 120 日最低歷史長度用來控制不同策略可用資料差異。
- 訊號 T 收盤，次交易日開盤執行，等權 long-only；保留不可成交的現金配額，沒有用次日贏家替補。
- 使用當時普通股／可交易狀態，未來資料擾動不影響過去訊號。持倉缺估值則報錯；下市有明確結算、拆併股與股息進入帳務。
- 輸出全部要求指標、benchmark、equity curve、trade log、FIFO 已平倉紀錄、未平倉部位、每日訊號篩選統計；版本、參數與資料雜湊可追溯。
- 目前未提供符合契約的完整真實歷史資料，所有測試結果屬合成資料；不宣告 A/B/C 的樣本外勝負。

## 工具與驗證紀錄

- exec_command：讀取根 AGENTS.md、專案狀態、package.json、operational policy；記憶 registry 搜尋無命中。
- exec_command：完整讀取 Sites building/hosting 規範及各自 environment 參考。
- apply_patch：新增 lib/backtest/strategies.mjs、engine.mjs、CLI、12 項測試與中文文件，package.json 新增 backtest:run/test。
- npm run backtest:test：12/12 通過，包含未來資料擾動、T+1 成交、資料不足、不同策略規則、費用、下市、拆股股息、績效計算、週退出、停牌、CLI 重現與覆寫保護。
- eslint：新增研究程式檢查通過。
- build-verified.sh：既有網站 production build 與 artifact 驗證通過。

## 待辦與限制

待提供經稽核的 point-in-time 股票行情、交易資格、公司行動、退市事件及大盤總報酬基準；先鎖定樣本外區間，再以同一份資料／成本／期間執行三策略。provenance true 只是交付聲明，不能代替來源稽核。後续報告不得把測試資料當成歷史市場績效。

每日 operational 下一交易日驗收不因研究引擎完成而自動視為通過；也不得將先前保存的 snapshot checksum 當作目前 operational 全資料內容 checksum。

本次不改 Historical Snapshot、catching_up 寫入路徑、production 推薦演算法或啟用策略 policy。下一步為資料契約核對及固定區間 baseline 比較，非參數最佳化。
