# Ver.0.8 第4段階：自動記録接続の設計・独立制御モジュール

2026-10-29。Draft [PR #37](https://github.com/asumax1128/mathjong/pull/37)、開始HEAD `fcdfdaffb20660eb06e187f491bbe141fc031140`、main `1603bdf3da18f93737eb6ec52813b6d6ea616eff`。[スキーマ](51-v08-paifu-foundation-schema.md)・[IndexedDB](52-v08-paifu-indexeddb.md)・[Worker性能](53-v08-worker-recovery-performance.md)と、GitHubの最新「ディレクター第3段階完了判定」を確認した。

**今回もapp.js/卓HTML/CSSを変更せず、通常対局には未接続。独立した接続契約と制御モジュールを検証する段階。Draft維持、mainマージ・Pages公開禁止。PR #36/エンジン/12人AI/得点/既存保存形式/URLには触れず、Ver.0.9以降へ進まない。**

## 1. 調査した接続点（開始HEADのapp.js）

| 境界 | 現行の場所 | 将来の接続契約 |
|---|---|---|
| 試合開始・設定確定 | `startMatch`（1602行付近） | モード/実際の席/players/Match/seedBase/firstRoundが確定してから新セッション。IDは暗号乱数等で一意にし、ゲームRNGを使わない。URL再現はorigin=replay-urlと途中局番号、過去100点開始のMatchをそのまま渡す |
| Game生成・配牌・親の最初のツモ | `startRound`（153行付近） | コンストラクター直後、AI開始前に`roundStarted(g)`。最初のdrawは既に起きている。通常はseed、明示fixtureだけsnapshot |
| 人間操作 | `applyHumanAction`（282行付近）、`humanAct` | 実際のapplyActionの直前/直後だけ観測。選択・長押し・並び替え・リーチ選択/キャンセル・ヒントは行動にしない |
| 自動パス | `step`（215〜224行付近） | 現在は同じapplyHumanActionを使うため、将来この呼出元だけsource=auto-passを明示する。既存autoPassDueのロン保護と設定固定を保持 |
| AI操作 | `step`のタイマー（237〜258行付近） | decideCharacterとAI RNG消費は従来どおり。その**後**にbefore→applyActionを1回→after。既存のg!==S.game/ドラッグ保留ガードを維持 |
| 打牌・リーチ・ツモ・鳴き・ロン・見送り | 上記3経路のapplyAction | source=human/ai/auto-passを呼出元で確定。各合法判断をstepsへ保存。リーチは成立打牌に付随し、ツモは直後のstate.drawnから補う |
| 鳴きの保留/優先解決 | Game.respond→後続判断 | チー/ポン選択と成立eventを区別。ロンで取り消されても選択した判断は残す。ゼロeventのpassもseqを持ち、Game.events.lengthを判断IDに使わない |
| 和了/流局と精算 | `finishRound`の!S.scored内（261〜274行付近） | 最後のGame判断を先に記録し、既存applyRoundResultが成功してS.matchへ入った直後に`roundSettled(g,S.match,{maxRound:MAX_ROUND})`。記録側は精算を実行しない |
| 次局 | nextボタン（1379行付近）→startRound | 前局が精算済みであることを照合。新Gameを初期状態から記録。親/通し局/連荘/得点は既存Matchを正とする |
| 新試合・再戦・タイトル | reset/retry/leaveGame（1582行付近） | 元の設定/記録を上書きする**前**にleave(reset/left-match)。既にcompleteならcompleteを維持。新試合は別セッション/別ID |
| ページ離脱/背景化 | 現在は音声dropのみ（376〜377行付近） | visibility/pagehideでbest-effort checkpoint。背景化/BFCacheを途中退出と偽らない。終了時の非同期保存完了を保証しない |

これらは**調査・将来の接続案**で、行番号の場所にコードを挿入したという意味ではない。初心者教材/ローカルdebug goRoundのGame交換は通常対局セッションへ混ぜない。将来接続時に対象画面/世代を明示する。

## 2. 行動と記録の失敗を分離する

`src/ui/paifu-session.js`の`createPaifuSession(config, options)`を追加。DOM・イベントリスナー・AI呼出・Gameのmonkey patchはない。Gameへ操作を実行するAPIも持たない。既存paifu builderの全検証とWorker storeを利用する。

接続例（今回はapp.jsへ未適用）：

```js
const ticket = session.beforeAction(g, {seat, action, source});
try {
  applyAction(g, seat, action); // 呼出元の従来処理。ticketがnullでも実行する。
} catch (engineError) {
  session.afterAction(ticket, g, {accepted:false});
  throw engineError; // 本来のエンジン拒否/呼出元の処理を隠さない。
}
session.afterAction(ticket, g, {accepted:true});
// ここで保存完了をawaitして描画/AI/次の手番を止めない。
```

- beforeは固定フィールドのsnapshotと小さいactionコピー、opaque ticketを作る。afterは現在のGame参照/世代/順序を照合して、既存appendDecisionで独立に再実行/全状態比較する。二重after/古いGameの通知を追加判断にしない。
- accepted=falseは元の状態が変わっていないことを確認して追加しない。失敗扱いなのにGameが変わっていたら、その変化を合法行動と偽らず記録を停止する。
- source=auto-passはhuman/passだけでなく、その時点の宣言権・鳴き選択肢・ロン不可を確認。設定ON/OFFの正しさは元のautoPassDue/固定方針の責任であり、このメタデータだけでは証明しない。
- 捕捉/append/時刻/精算照合が失敗しても、成立したGame/Matchを巻き戻さない。記録だけfailedとし、最後の有効prefixを可能ならaborted/recording-errorで閉じる。エラーに私有データや例外全文を含めない。
- roundStarted/roundSettledの同じGameへの重複通知は追加しない。重複精算通知の内容が異なる場合は記録エラー。本体の二重精算を防ぐのは既存S.scoredであり、観測モジュールが壊れた本体処理を修復するとは主張しない。
- source・action・afterをafterオプションで上書きできない。任意の記録本文をAI/公開共有へ返すAPIはない。privateRecord()だけが凍結済みの私有本文を返す。status()は管理情報だけ。
- モジュールimport/初期化の失敗自体は、将来の呼出元でも独立に扱う必要がある。正常ゲームを記録の成功/チケット有無へ依存させない。

## 3. 生命周期と保存の状態

recording側はactive/closed/failed、保存側はidle/scheduled/saving/paused/stopped/disposedを分離する。

- `roundStarted`：初期状態と最初のdrawを記録し、局開始checkpointを要求。
- `beforeAction`/`afterAction`：成功判断を**毎回メモリへ**記録。UIキャンセル等を捏造しない。
- `roundSettled`：実際の精算結果を照合し、局終了checkpointを要求。正式Match.overが成立した場合だけrecord.status=complete。
- `tick`：前景で呼出元が周期的に呼ぶためのAPI。after成功時も時刻を確認する。初期値30秒を過ぎて未保存変更がある場合だけcheckpoint要求。モジュール自身に常駐interval/DOM listenerは作らない。
- `checkpoint`：手動/ページ離脱などの要求。戻り値のqueuedは保存成功ではない。
- `flush`：呼出時のversion以上がackされるまで待つ明示API。更新が続くゲーム全体の停止/無期限の完了を待たない。通常の行動/描画経路ではawaitしない。
- `leave`：意図した途中退出はaborted、完走済みはcompleteを保持して最終保存を要求。closedは保存済みを意味しない。
- `retrySaving`：既知の失敗だけを明示再要求。capacity-exceededは容量確保後の手動再要求を許す。不確定/競合の再試行は禁止。
- `stopSaving`：新規要求を永久停止し、既に投稿した1書込みの結果を待つ削除前barrier。記録自体は継続できるが再保存しない。
- `dispose`：Worker等を明示解放。flushではなく、保存完了の保証ではない。急に切れたrecording prefixをcompleteにしない。

statusのversion/savedVersionはセッション内だけの番号で、保存形式へ新フィールドを追加しない。savedVersion/savedStatusは**最後に確認できたackの履歴**。別タブでの削除/変更後もDBの現存を保証する値ではない。

## 4. キューと障害方針

コントローラーは同時writeを1件にし、保存中の追加要求は最新の凍結済みrecordへの参照1件へまとめる。**まとめるのは保存時点であり、全判断列を間引くものではない。** 最新snapshotにはそれ以前の全判断/精算が入る。1件が成功し、追加要求があった場合だけ次を送る。これは成功後の新version送信であり、失敗処理の自動retryではない。

| 条件 | 処理・データ損失の範囲 |
|---|---|
| Worker queue-full | 保存paused。メモリ記録は継続。共有store等の混雑解消後に明示retry。自分自身はwriteを重複投稿しない |
| quota/unavailable/blocked/確定したtimeout | 保存paused。勝手に消去・fallback・自動retryしない。最後のack以降は未保存として扱う |
| outcome-unknown/保存Promiseのthrow/不正ack | ackを進めずpaused。commit済みか不明。retrySavingはreconciliation-required。loadPrivate/verifyによる照合と権限ある回復は別の明示操作として設計し、今回は自動採用/再接続を実装しない |
| CAS conflict | 他タブ変更や削除後の古いtoken。paused、再照合必須。null tokenへ戻して同じIDを勝手に再作成しない |
| 件数/合計容量超過 | 20件/本文32MiBの既存制限を維持。自動削除せず、ユーザーが容量を確保して明示retry |
| 1牌譜8MiB/構造限界 | 既存の完全検証/コードク上限を維持。記録だけ停止、最後のackを保持。新しいメモリprefixが保存できると偽らない。分割/移行は別設計 |
| 暴走/無期限の記録 | 先行制御の既定は4000判断/64局で記録停止（設定可能）。ゲーム/正式ルールの局数上限ではない。厳密なRAM上限でもない。長い連荘の無制限記録は保証しない |
| 途中退出/新試合 | 旧セッションを閉じてbest-effort保存。新Gameは別ID/別セッション。旧完了callbackが新試合へ触れない |
| タブ終了/OS kill/電源断 | 最後の確定済みtransactionまで。有効なrecording prefixであり、和了/流局/精算/completeを補完しない |

既定のWorker全要求期限30秒（待機を含む）、下位の各非同期待機5秒、Workerキュー上限2件を変更していない。タイムアウトを延長して成功と見せかけない。戻り値/Promiseには保存失敗を明示し、UI向け通知は将来の接続側で実装する。

## 5. 手動削除と新試合の資源調停

管理された削除は、同じセッションへstopSavingを実行してin-flightの終了を待つ→状態/DBの明示確認→最新tokenを使う個別削除、の順。barrierは未投稿writeを抑止するが、投稿済みwriteを巻き戻すものではない。不確定ならまず照合し、無条件に「削除済み」と断定しない。同じIDの書込を再開しない。

別タブで勝手に削除された行への古いCASはconflictになる。未確定の初回createと外部削除の順序まで、調停なしに全て防げるとは主張しない。全削除では関連する全writerを停止する必要がある。今回は削除UI/他タブ通信を追加しない。

将来の新試合への切替で旧flushを待ってUIを止める案は採らない。一方、旧セッション/Workerを無制限に残すことも不可。**active 1＋終了処理中1等の上限**を設け、連続リセットで資源が空かない場合は新試合の記録を見送り、ゲームだけ開始する案を推奨する。局途中から記録を捏造して再開しない。このアプリ全体の調停は今回未実装で、全面接続前のゲート。

## 6. 保存頻度と推奨案

メモリ記録は毎判断。以下は**ディスクcheckpoint頻度の比較**であり、試合/判断を間引く案ではない。

| 保存方式 | 回数の目安 | 健全時の未保存範囲・課題 |
|---|---|---|
| 毎判断 | 数学Ⅱ8局の合成例で1580回＋境界 | 1判断＋in-flight。全履歴再検証/cloneが累積し、大きい牌譜で負荷が高い |
| 試合終了だけ | 完走時1回 | 試合全体を失う。途中退出/OS終了に弱い |
| 局終了だけ | 同8局なら8回 | 進行中1局＋in-flight。長い局や連荘中に未保存期間が長い |
| 局開始/精算＋前景30秒＋意図した退出 | 最大約16境界＋前景T秒でceil(T/30)＋退出（近接要求は統合） | 最後の成功ackからの変更。正常・前景・定期tick/保存成功が続く場合に約30秒＋書込待ちを目安とする |

**推奨は最後の方式**。独立モジュールの既定として局開始/精算/退出と30秒判定を先行実装したが、本番の周期/通知を承認・実装済みとは扱わない。

第3段階の数学Ⅱ8局・約4.28MBは総保存約685.6ms、投稿同期約26.7ms。30秒ごとなら単純計算で総保存時間/間隔は約2.3%相当だが、CPU利用率の実測ではない。保存総時間はWorkerで短縮していないため、毎判断保存は推奨しない。今回の実AI4試合は32局926判断であり、合成1580判断例や任意の実対局の平均と混同しない。

**30秒以内の損失を保証しない**。背景タブのtick抑制、メイン処理待ち、5秒/30秒の失敗期限、容量不足・未解決障害では未保存期間が伸びる。afterActionだけの時刻チェックでは人間の長考中に保存されないので、全面接続時には前景の定期tickも必要。pagehide中の非同期flush完了やSafariの端末保存保持も未保証。成功ack以外を保存済みと表示しない。

## 7. 検証と未完成事項

### 今回の独立実行結果

| 検査 | 結果 |
|---|---|
| 全単体npm test | **470件成功：既存438＋新規32、失敗・スキップ0**。約161.2秒 |
| 新規session E2E | **13項目成功**。実Worker/IDB、source・prefix、queue-full、容量、削除barrier、実timeout/不確定、AI比較、24連荘、ページ再読込 |
| 第2段階IndexedDB E2E | **21項目成功**。破損・未知版・quota注入・native abort/timeout・タブ終了・接続解放 |
| 第3段階Worker E2E | **14項目成功**。CAS・容量・31反復・途中終了・再開 |
| 基礎牌譜ブラウザE2E | 数学ⅠⅡ×320/390pxの**4条件成功** |
| 既存関連E2E | `v06TrioIntegration,v07BeginnerRoom2,v05Riichi,v04End`全項目成功 |
| 構文・差分・リンク・workflow | 成功 |

新規単体の故障注入では、before capture/append/精算観測/scheduler/clock/保存throw/不正ack、保存失敗後の明示retry、uncertain/conflictの再照合待ち、手動削除barrier中のin-flight、判断/局数上限、誤auto-pass/Ron、after引数の上書き防止を確認。保存/記録の失敗で実Gameの成立打牌・和了・RNG・400点を変えない。記録器がゲーム操作を実行しないことを前提とした観測テストである。

実ブラウザの数学Ⅰ/Ⅱ×4/8局、**4試合32局926判断**で、12人のIDを網羅し、非記録対局との判断・全状態・次RNG・精算・最終結果が一致。観測hook（before＋after、AI/操作適用/保存を除く）のp95は約1.1〜1.6ms、最大約5.6ms。合成小標本/実行環境の値でありSafariや長期の最大値を保証しない。24連荘fixtureは実エンジンの合法な判断列を観測し、途中退出のabortedと全精算を既存牌譜と一致させた。

初期の新規テストでは、capture失敗時に未登録handleが返る欠陥を検出し、snapshot成功後にhandleを作るよう実装を修正（null期待は維持）。新規E2Eの初回は復元後JSONのオブジェクトキー順の比較で失敗し、意味を持たないキー順だけ正規化。物理牌/行動/配列順と全値の比較は保持して再実行成功。

機械可読の実数・コマンド・ソースhash：[validation/v08-paifu-session.json](validation/v08-paifu-session.json)。通常画面への接続がないため、既存画面は上記関連グループを選定し、全体play.mjsは今回再実行していない。選定した検査のskip・検証弱体化・失敗の握りつぶしはしない。Chromium 154での実装者自身の確認であり、別担当者の独立監査、Safari/WebKit、公開サイトの合格とは扱わない。

専用CIにこのモジュール/単体/E2Eを追加し、既存の全単体・牌譜/保存/Worker/性能/関連E2Eを残した。新HEADの結果はpush後のPR #37で確認し、第3段階のSuccessを流用しない。

残るゲート：

1. app.jsの3行動経路・精算ガード・開始/退出への実接続。今回は禁止のため未実施。
2. 保存エラー通知/照合・容量管理・他タブ削除調停・終了中sessionの資源上限。
3. Safari/WebKitのWorker/IDB/長期RAM/プライベートモード/ページ終了/バックグラウンド再開。
4. 8MiB超の分割・版移行・大容量時の負荷。既存検証を省略して解決しない。
5. 動的import/初期化失敗の扱い、接続後の全UI経路/二重入力/高速AI/ドラッグ競合の再検査。

全復元は保存した判断列によるGameの再生であり、任意の途中局面から将来のAIを同じ内部メモリ/RNG位置で再開する機能ではない（docs/51の制限を維持）。

この制御モジュールは未来の接続を検証する独立基盤であり、通常対局の自動記録機能の公開完了ではない。Ver.0.9以降の画面・新ルールへ進まない。
