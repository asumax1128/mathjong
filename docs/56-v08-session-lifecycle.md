# Ver.0.8 第6段階：セッション管理・保存状態の安全設計

2026-10-30 JST（2026-10-29 UTC）。Draft [PR #37](https://github.com/asumax1128/mathjong/pull/37)、開始HEAD `a85d44d7e1c9168e66488bee90147ec25dc88593`、main `1603bdf3da18f93737eb6ec52813b6d6ea616eff`。docs/[51](51-v08-paifu-foundation-schema.md)・[52](52-v08-paifu-indexeddb.md)・[53](53-v08-worker-recovery-performance.md)・[54](54-v08-auto-recording-connection.md)・[55](55-v08-recovery-audit.md)、PRの最新「第5段階ディレクター判定・次ゲート」を確認した。

**通常対局には未接続。app.js/卓HTML/CSS/PR #36/既存エンジン・ルール・数学ⅠⅡ・AI12人・得点・保存形式・再現URLを変更しない。PR #37をDraft維持し、mainマージ・Pages公開・Ver.0.9以降の開発は禁止。**

## 1. 今回の独立モジュール

- `src/ui/paifu-lifecycle.js`：`createPaifuLifecycle()`。DOM/常駐listener/ゲーム操作なし。既存session/Workerを所有する資源調停。開始/退出でゲームをawaitしない。
- `src/ui/paifu-save-state.js`：`describePaifuSaveState(status,{inspection,released})`。保存状態から静的な短文と限定した管理情報を作る純粋関数。画面へは未接続。
- 第4/5段階のsession/保存/照合コードを変更せず利用する。スキーマ/DB版/容量/CAS/完全復元検証を変更しない。

これは実装者自身の検証であり、第5段階の別Codexによるレビューを今回の新HEADの独立監査と呼ばない。

## 2. 所有数と寿命

**同一アプリ/realmが共有する調停インスタンス1個につき、対局中最大1、終了処理中最大1。** 別タブ・別インスタンス全体の排他/上限ではない。将来の接続側は共通インスタンスを1個だけ所有する。別タブのデータ更新は既存のnative IndexedDB transaction/CASで保護し、このモジュールで横取りしない。

```js
const manager = createPaifuLifecycle();
const opened = manager.start(config); // 同期、成功しても保存成功ではない
if (opened.recording) {
  const session = opened.session; // 私有の接続用。UI/ログへ丸ごと渡さない
  session.roundStarted(game);
  // 既存before→ゲーム操作1回→after契約はdocs/54どおり。
}
// 記録を見送っても、Game/AI/表示の開始は呼出側がそのまま実行する。
manager.end('left-match'); // タイトル退出。保存完了をawaitしない
manager.checkpoint(); // pagehide/背景化の接続案。退出/completeにはしない
manager.dispose(); // 終了保存ではない。急な切断は結果不明になり得る
```

IDの生成は今回追加しない。接続側がゲーム用RNGを使わない新規IDを渡す。既存IDへの初回保存は従来のCAS契約で拒否され、自動上書きしない。同じ試合の途中からstartを再試行して初期配牌を偽造してはならない。

| 状態/入力 | 処理 |
|---|---|
| 空→start | store/sessionを初期化。Workerは既存方式どおり最初の保存要求まで作らない |
| activeあり/closingなし→start | activeをreset退出→closingへ。新試合は別activeとしてすぐ開始可能 |
| active+closingあり→start | 古いactiveの未投稿要求を停止し、退出/資源解放。新試合の記録は見送る。古いclosingだけ保持する |
| activeなし/closingあり→新試合start | 新しい試合開始時に限りactiveへ受入可。見送った試合を自動で途中記録しない |
| タイトル退出 | activeをleft-matchで閉じ、空きがあれば最終flushを非同期要求。枠が埋まっていれば上記の制限で解放 |
| 最終flush成功/既知失敗/不確定 | 結果が返った時点のstatus概要を残し、Workerを閉じてclosingを解放。失敗を成功へ変えず、retryしない |
| 終了処理期限 | 既定35秒で解放。投稿済みwriteは結果不明、未投稿の要求は取消。ゲームを待たせない |
| 初期化失敗/例外/Worker不可 | 記録だけ失敗。所有storeを閉じ、私有の例外文を返さない。黙ってmain-thread保存へfallbackしない |
| 解放処理自体が失敗 | cleanupFailedとして新資源作成を停止。ゲームは続行可能。別managerを自動生成して回避しない |
| dispose | 全所有sessionを解放。新規startを拒否し、遅れた旧callbackが別世代を閉じない |

**飽和時には未保存分を失う可能性がある。** 全牌譜の完全保存と資源上限を同時に無条件保証するものではない。古い2件を保持したまま新しい3件目のprivateコピー/Workerを作る方式は採らない。解放後は`released`/未保存数/不確定・要確認の概要を残し、ユーザー説明でこの制約を隠さない。DBに残る確定prefixは勝手に消さない。

既定35秒は前景timerによる猶予であり、OS背景化/メインスレッド停止時の厳密な実時間上限ではない。抑制中も枠は増やさず、必要なら記録だけ見送る。Workerの既存30秒期限や下位5秒期限は変更していない。

### 参照・timer管理

- 終了timerは最大1個。通常終了/disposeで取消。世代番号を照合し、古い通知が新試合/新closingへ作用しない。
- session/store参照は解放時に調停側から外す。閉じる関数は冪等で、ラッパーを介してstoreの`this`も維持する。
- 進行中のPromiseが遅延してもcallbackに私有session自体を持たせない。既存Worker closeでpendingを完了させる。
- statusは現在2件＋直近8件の**本文なし概要**だけ。古い不確定を新しい終了で隠さないよう、要確認フラグも保持する。保存本文やsnapshotを履歴配列へ溜めない。
- 呼出側が返されたsession/privateRecordを保持し続けた場合のGCや、ブラウザ内部のWorker終了時刻・厳密な総ピークRAMまでは保証しない。外部が別store/managerを生成した分も上限の対象外。

## 3. 保存状態の表示モデル

| state | 意味/短文の要旨 |
|---|---|
| saved | この時点までの成功応答を確認。現在のDB現存や試合完走を意味しない |
| unsaved | 未保存変更、開始時0/0、利用不可等。未保存として扱う |
| saving | scheduled/in-flight。完了未確認 |
| uncertain | outcome-unknown。commit/rollbackを断定せず読取り確認が必要 |
| capacity | quota/論理容量/1件上限。勝手に削除しない |
| conflict | CAS競合。上書きしない |
| review-required | 記録エラー/破損/未知版/照合結果の検討が必要 |

- `version/savedVersion`は最後のackの事実だけ。0/0・不正値・新しいdirtyを保存済みとしない。`savedStatus`のrecording/aborted/completeを別に保持し、保存済み≠完走とする。
- 明示的なinspectRecovery結果を渡してもsavedVersionを増やさず、再試行/再開を許可しない。元の問題が不確定/競合だったことはissueに残す。
- 同じID・対象version・失敗種別・読取専用の結果だけを採用。古いversionなら、その照合対象versionを別に表示し最新分の保存と混同しない。不一致/失敗結果は安全に照合できていない旨を返す。
- 「同内容が存在した」「行が見つからなかった」「別内容だった」は**読取snapshot時点の観測**。書込者/元transactionの成功/削除理由/将来の現存を断定しない。
- status本文のID・token・digest・手牌・山順・任意エラー文/例外を出力しない。表示文は固定文だけ。ログ出力/ネット送信/AI入力/DOM描画は追加しない。

## 4. 競合コピーの保全案（実装していない）

| 案 | 利点 | 制約・権限 |
|---|---|---|
| 既存IDをそのまま置換 | 追加容量が少ない | 履歴の正当な続きか未証明。現在は禁止。読取tokenだけを根拠に採用しない |
| 失敗snapshotをprivateな別IDへ保全 | 両方を残せる | ユーザー明示判断、新ID/各round ID等の整合、全検証、容量、重複保全防止、出所の別管理が必要。自動forkしない |
| 私有の手動export/一時退避 | ディスク不能時の退避候補 | 未公表情報・ファイル取扱・容量とUI設計が必要。今回公開共有/export/UIは作らない |
| RAMで保留 | 新形式不要 | reload/killで消える。上限付きにし、bounded lifecycleを超える追加コピーを隠して保持しない |

まず確定済みコピーと失敗snapshotを別々に全検証し、差分・対象versionを明示する。コピーの親子関係/履歴連続性はreceipt/digest一致だけで証明しない。保存失敗のまま元IDを変更せず、権限のある明示操作を別ゲートで設計する。

同じtab内の手動削除は既存stopSaving barrier→in-flight確認→必要なら照合→最新tokenで明示削除。別tab/全削除の全writer停止は未実装。BroadcastChannel等の通知だけではtransaction/CASに代わる排他や削除完了保証にならない。管理モジュールからremove/clearAllは呼ばない。

## 5. テスト・変更影響

新規単体は資源枠、飽和、保存中/未投稿の違い、旧callback、31周期、初期化/cleanup/scheduler故障、背景checkpoint、秘密の非出力、表示モデルの全状態/古い照合/不正値を検査。実ブラウザではnative Worker/IDB、数学ⅠⅡ×4/8局、失われたcommit応答、容量不足、freeze/active、31周期を検査する。

実装途中の新規単体ではアダプターの`this`参照を変えるラッパーの不備を検出し修正。自己レビューでactiveの要確認状態も集約フラグへ反映するよう補強した。新規E2Eの復元比較はJSONのオブジェクトキー順だけ正規化し、配列/物理ID/全値の比較を保持した。条件弱体化やskipはしない。

| 検査 | 第6段階で再実行した結果 |
|---|---|
| 最終npm test | **544件成功（既存499＋新規45）、失敗・スキップ0**。約155.2秒 |
| 新規lifecycle E2E | **12項目成功**。最終再実行約8.0秒。native Worker/IDB、数学ⅠⅡ×4/8局、飽和/期限/応答喪失/容量/背景化/31周期 |
| 既存復旧E2E | **11項目成功** |
| IndexedDB E2E | **21項目成功** |
| Worker E2E | **14項目成功** |
| 記録session E2E | **13項目成功**。12人AI・数学ⅠⅡ×4/8局の32局926判断、24連荘等を含む |
| 基礎牌譜E2E | 数学ⅠⅡ×320/390pxの**4条件成功** |
| 既存画面の関連E2E | v06TrioIntegration,v07BeginnerRoom2,v05Riichi,v04Endが**E2E PARTIAL OK**、約116.3秒 |
| 故障注入 | 隔離した一時コピーで資源飽和ガード無効化/不確定をsavedへ誤分類の2故障を検出し、どちらも終了コード1 |
| 構文/差分/文書リンク/CI定義 | 成功。保護対象のソース差分なし |

[機械可読の結果とソースhash](validation/v08-session-lifecycle.json)。今回もシステムChromium154.0.8037.57を外部起動ヘルパーで使用し、複数のブラウザ実行方式を検証したとは言わない。WebKitバイナリーはなく、Safari/iPhoneは未検証。実容量枯渇/OS killやピークRAMの検証ではない。

app.js/卓UIへ未接続で保護対象のソース差分がないため、全体play.mjsは今回再実行せず、上記4関連グループを選定した。第5段階の全体837秒成功を今回へ流用しない。テスト内のskip、エラーの成功扱い、アサーション弱体化は行っていない。単体は最終コードで全件再実行し、新規E2Eも最終版で再実行した。

専用CIに新規単体/12項目E2Eと構文検査を追加し、既存の全単体/保存/Worker/復旧/session/性能72操作/関連画面の検査を残した。contents:read・デプロイなし。新HEADのCIはpush後に確認し、開始HEADのCI40957905915のSuccessを流用しない。

## 6. 次のゲート・未完成

1. app.jsとの世代付き接続、見送った試合の操作を旧sessionへ渡さない契約、通知の実表示/動的importの失敗分離。
2. ユーザー選択によるコピー保全・書込み再開・手動削除/全tab調停。今回読取り照合の仕様も変更しない。
3. Safari/WebKitのWorker/IDB・プライベートブラウズ・OS kill・実容量不足・ピークRAM/長期GCの測定。
4. 8MiB超/長い連荘の分割と版移行。完全検証を省略したり、既存データを自動削除して解決しない。

**独立基盤としての第6段階であり、通常対局の自動記録/自動保存/完全な保存復旧の公開完成ではない。Draft #37を維持し、main/Pages/PR #36へ変更しない。**
