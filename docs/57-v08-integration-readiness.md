# Ver.0.8 第7段階：通常対局への統合準備・最終検証計画

2026-10-30 JST（2026-10-29 UTC）。Draft [PR #37](https://github.com/asumax1128/mathjong/pull/37)、開始HEAD `d7b3f3e74b25df8fb09abbc43452f6d5c3f8d511`、main `1603bdf3da18f93737eb6ec52813b6d6ea616eff`。docs/[51](51-v08-paifu-foundation-schema.md)・[52](52-v08-paifu-indexeddb.md)・[53](53-v08-worker-recovery-performance.md)・[54](54-v08-auto-recording-connection.md)・[55](55-v08-recovery-audit.md)・[56](56-v08-session-lifecycle.md)と、PRの最新「ディレクター第6段階判定」を確認した。

**今回は接続設計・独立テストのみ。app.js/卓HTML/CSS/既存エンジン・数学ⅠⅡ・12人AI・得点・保存形式・再現URLは変更しない。PR #36は変更/取り込みしない。PR #37をDraft維持し、直接mainマージ・Pages公開・Ver.0.9以降の開発をしない。** Ver.0.7新卓の承認・統合後、最新mainから**別の統合PR**を作る。ここに書く接続箇所・表示は未実装であり、統合合格/公開承認ではない。

## 1. 現行app.jsの接続地図

行番号は開始HEADの調査位置。将来の新卓では**関数と意味的境界を再調査**し、古い行番号で自動patchしない。[調査ソース](https://github.com/asumax1128/mathjong/blob/d7b3f3e74b25df8fb09abbc43452f6d5c3f8d511/src/ui/app.js)。

| 場所 | 将来必要な変更・順序 | 保持する既存動作 |
|---|---|---|
| タイトル初期化/初期render、1634〜1635 | 記録用moduleを非同期preload。失敗を受け止め、ゲーム起動を待たせない。本文/IDB/Workerはここで作らない | タイトル・再現URLエラー・初心者入口 |
| startMatch、1602〜1631 | 最初に旧試合の接続tokenを失効。設定/席/PLAYERS/実rules/S.match/S.seedBase/S.round確定後、startRoundより前に新tokenと記録可否を1回確定。旧終了処理はmanager.startに任せる | 座席shuffle・新山・再戦設定保持・100点開始 |
| startRound、143〜174、特に153直後 | new Game直後、最初のAI/step前に同じtokenでroundStarted(g)。Game参照とgameSerialを束縛。初回drawは既に発生済み | seedBase+round×7919、AI RNGの生成/消費、warmUp、手牌順/ヒント初期化 |
| applyHumanAction、282〜292 | 手番ガード後の実applyActionだけをbefore/afterで囲む。sourceをhuman/auto-passで明示。記録例外とengine拒否のcatchを分離 | ignored/failed/okと既存入力カウンター、2回tap |
| 自動パス、215〜224 | applyHumanAction(pass)のこの呼出元だけsource=auto-pass。別途二重ラップしない | ロン保護、宣言方針固定、tried、通知、step(true)の順序 |
| AI timer、237〜258、特に239/255 | timer生成時のmatch tokenとgをcapture。callback冒頭で両方を照合し、無効ならdecide/RNG前にreturn。既存decideCharacter/計測/カウンター後のapplyActionだけ観測 | g!==S.game、dragging保留、AI ID/係数/公開履歴/乱数、changed描画規則 |
| finishRound、261〜274、特に271直後 | !S.scoredの既存ガード内、applyRoundResultが成功してS.matchへ反映された直後だけroundSettled(g,S.match,{maxRound:MAX_ROUND})。実sessionにround等の未対応optionsを追加しない | 精算1回、親子の支払い/連荘、normal/round-limit、400点、history |
| next、1375〜1380 | S.match.overなら最終表示だけ。続行時だけS.round++/startRound。同じ試合token、別Gameへ | 最終局後に架空局を追加しない、親/連荘をMatchから決定 |
| reset/again、1381〜1389 | 新しい試合tokenを発行するstartMatch経路を再利用。事前のmanager.end(reset)を重ねない | againは旧matchSettings、resetは予約mode、seat再抽選、既存seed更新 |
| leaveGame、1582〜1594 | 最初にtokenと現在Game束縛を失効し、元sessionへend(left-match)。保存はawaitせず、既存のtimer/drag/hint/fx/sound停止→S.game=nullを維持 | タイトル/相手変更後の遅いstepは何もしない |
| visibilitychange/pagehide、376〜377 | 音のdropを維持したまま、記録側だけbest-effort checkpoint。ゲーム/AI timerを流用しない。pageshow時は同じscopeか確認 | 背景化/BFCacheを途中退出/流局/完走へ変換しない |
| drag後の遅延step、1565 | 記録はstepの呼出回数でなく成立applyActionでのみ増やす。記録結果からstep/renderを呼ばない | 遅延再開/二重timer防止、短いtapを潰さない |
| br-open/practice、1396以降・goRound、1572 | 初心者/局面fixture/ローカルdebugのGame交換は通常scopeから除外。通常試合を離れる正規経路では先にtokenを失効 | 教材進捗/練習用CPU/テスト山を通常牌譜へ混入しない |

実configは`rules`、**実際の席順のPLAYERS**、S.match、seedBase、firstRound、originを使う。選択順のcharsや予約中S.nextModeを誤採用しない。URL開始は検証済みREPLAY/RVとmatchAtを使い、100点/履歴なしをそのまま記録する。再現URLの新キー/復元機能は追加しない。app/source版を取得できなければnullとし、過去SHAを現在の版と偽らない。

記録IDはcrypto.randomUUID/getRandomValues等のゲームRNGを消費しない方式。使えなければ記録を見送る。Math.randomやAI RNGで代用しない。通常記録はsetup=seedで、presetWall/debugは除外する。fixture snapshotは明示テスト専用。

## 2. 世代管理・初期化の契約

### 三つの識別を分離

1. **試合token**：通常試合開始ごとのopaque object。記録を見送った試合にも発行し、旧callbackを遮断する。recording可否とゲームの正当な進行可否を同じflagにしない。見送り理由はその試合のadmission結果として保持し、manager.lastSkipなど旧試合の値だけで現在の説明を決めない。
2. **Game参照＋gameSerial**：同じ試合の次局を区別。round=1や同じseed/物理牌IDを新試合の識別に使わない。
3. **記録session/generation＋要求ID/version**：Worker応答・保存説明・読取り照合を対象scopeへ束縛。古い応答を新しいsaved表示へ採用しない。

描画・timer callbackは現在のグローバルsessionを取り直すのでなく、そのGameに束縛したobserverを使う。actionの前後でawaitしない。UI選択/ドラッグ/ヒント/キャンセルは行動にしない。ゼロeventのpassも1判断であり、Game.events.lengthやstateKeyだけを記録の重複判定に使わない。

### 試作で検出した接続上の落とし穴

**再戦前にmanager.end(reset)を呼んでからmanager.startする案は採用しない。** 第6段階manager.start自身が旧activeの終了/資源飽和を判定する。事前endでactiveを消すと、新試合の記録見送り判定を迂回する。試合tokenの失効は先に行うが、資源の入替えはstartに一元化する。明示的なタイトル退出はend(left-match)を使う。

これは今回の**テスト専用試作**で発見/修正した契約不備。既存製品のP2や、接続済み本番での再現とは扱わない。docs/54の一般的な旧leave案より、第6段階managerの契約とこの順序を優先する。

### 動的importと最初の試合

| 候補 | 評価 |
|---|---|
| 記録moduleを通常起動の必須static importにする | fetch/parse失敗でゲーム全体の起動まで失敗し得るため推奨しない |
| startMatch内でimport完了をawait | ゲームを待たせる。遅延/失敗時の開始停止を避けられない |
| タイトルからbest-effort preload、初回Gameまでに未readyならその試合は記録見送り | **推奨案**。ゲームは進む。遅いimport完了は以後の新試合だけで利用する |
| import完了時に進行中Gameへ後付け | 初期配牌/既済み判断が欠けるため禁止 |

**未決のUX**：推奨案では起動直後や再現URL直起動の試合が記録されない場合がある。見送りを短文で知らせる仕様と、全試合記録を必須にするかは統合前にディレクターが決定する。無断で開始を待たせたり、中途局面を初期状態に見せかけない。今回このUXを公開仕様として確定/実装していない。

preloadは同じPromiseを再利用してrejectを処理する。遅い完了からmanager.start/Game生成/renderを呼ばない。初期化失敗後の同一試合の再接続、障害中の無限import/Worker再生成、cleanupFailedを別managerで回避する処理を作らない。

## 3. 行動・精算のエラー分離

- 既存applyActionは従来どおり**1回だけ**。beforeがnull/失敗でも合法操作を止めず、afterが失敗しても操作を再実行/巻き戻ししない。
- applyAction自体の拒否は既存のhuman/AIエラー経路へ戻す。拒否で状態が変わっていなければ判断を保存しない。記録の例外catchでエンジンの拒否を成功扱いしない。
- 観測例外はobserverをその試合から切り離し、有効prefixをrecording-errorとして閉じる案。managerの既存枠で終了処理し、記録だけ停止。次の局から無断で記録し直さない。
- 正常な保存失敗（quota/不確定等）はメモリ記録の故障と区別する。sessionのpaused/失敗状態を表示し、成立済みGame/Matchは変更しない。
- 精算の正は既存applyRoundResult。sessionへはその結果を渡すだけで、記録器がlive Matchを二度精算しない。観測失敗後もS.scoredを戻さない。未精算を完走や流局へ補完しない。
- 記録からの通知にprivateRecord/失敗snapshot/例外全文を添えない。既存console.errorへ記録例外を流さず、固定codeと表示モデルで扱う。

## 4. 保存状態の簡潔な表示案（未実装）

| 状態 | 短い表示の例 | 意味/操作 |
|---|---|---|
| saved | 保存確認済み | 最後のackまで。DBの現存/試合完走を保証しない |
| unsaved | 未保存 | 最新分は保存未確認。開始時0/0も含む |
| saving | 保存中 | 完了未確認。描画/AI/操作は待たない |
| uncertain | 保存結果を要確認 | commit/rollback不明。自動retryなし |
| capacity | 保存容量不足 | 既存記録は削除しない。件数/本文上限/実quotaの違いは詳細へ |
| conflict | 保存が競合 | 自動上書き/token採用なし |
| review-required | 保存状態を要確認 | 破損/未知版/照合結果の検討が必要 |
| 記録見送り | この試合は記録していません | 資源/初期化/未ready等。ゲームは続けられる |

docs/56のdescribePaifuSaveStateの定義を変えず、表示用短ラベルとの対応を付ける。statusの取り出し/純粋な説明だけをrenderで行い、renderからsave/verify/loadPrivateを起動しない。卓の面積を増やさないため、**設定画面と局/試合結果の小さい欄**を第一候補とし、最終位置は承認済み新卓との調整で決める。危険色の強い点滅、操作を覆うモーダル、毎描画のtoastは追加しない。

非同期応答で手牌を含むapp全体を再描画するとtap/ドラッグを壊す可能性がある。専用文字ノードの小更新か、次の既存renderで反映する案を比較する。更新前にtoken/要求ID/現在画面を照合し、固定文はtextContent/既存escapeで出す。終了中の旧試合の警告は「前の試合」と分離し、新試合の保存済み表示へ転用しない。

照合ボタンを設ける場合も明示操作だけ。結果は対象ID/versionへ照合して表示し、savedVersionや停止状態は進めない。「同内容が存在」「行が不在」はその時点の事実で、元write成功・削除理由の証明ではない。再開・コピー保全・削除UIは別ゲート。本文/手牌/山順/ID/token/digestを画面・ログ・AI・共有へ出さない。

## 5. 背景化・終了・保存頻度

- 毎判断はメモリ記録。局開始/精算/退出＋前景30秒の既存案を維持するが、30秒以内の損失を保証しない。
- 前景tickのtimerはAIのS.timerと別に最大1個。長考中にもtickし、タイトル/見送り試合では止める。listenerはアプリで一度だけ登録する。
- 周期保存の同期cloneがドラッグを妨げるならdragging中は周期要求だけを延期する案。行動の記録は間引かない。延期で未保存時間が伸びることも測定する。
- visibility hidden/pagehideはcheckpointのbest effort。非同期flushをawaitして終了を保証することや、unload確認ダイアログでゲームを拘束することをしない。
- BFCacheのpagehideで無条件にleave/disposeしない。pageshow後も同じscopeなら前景tickを1個だけ再開。不確定/競合をresume時に自動retryしない。
- OS kill/電源断では最後に確定したtransactionのprefixまで。recording/abortedをcompleteに変えない。復帰後の新試合は新ID。
- active1＋closing1/終了35秒/8件の本文なし概要、Worker30秒、IDB5秒、8MiB/20件/32MiB、4000判断/64局の既存制限を保持する。背景timer抑制中の厳密な解放時刻や総RAM上限は未保証。

## 6. 検査マトリクスと証拠

### 今回追加する独立検査

`tests/paifu-integration-harness.mjs`は**テスト専用の接続契約試作**。app.jsへimportせず、Game/UIをmonkey patchしない。`tests/paifu-integration-contract.test.js`から既存の実Game/Match/session/lifecycleを呼び、未接続の呼出側契約を検査する。試作の合格は将来の実app.js接続の合格を意味しない。

- import未ready/遅延/reject、タイトル退出後の遅い完了。A/B途中へ接続せずCの開始だけで利用。
- 数学ⅠⅡでimport/manager/session/Worker/IDBの失敗を個別に注入。Worker ctor/IDB getterが実際に呼ばれた回数も確認し、手前の失敗で空振りしない。IDBのSecurityErrorはNode注入でありSafari実機試験ではない。
- 記録あり/なしの同じGameを直接比較。成立打牌、全物理牌領域/イベント、次RNG、400点、実和了の精算を確認。
- 旧試合のAI通知が新Game/新記録/判断前RNGへ作用しない。前局のGame/精算を次局へ混ぜない。
- 飽和で見送ったCはゲームだけ進み、A/Bへ記録せず、Dは新しい初期状態から開始。
- before/after/精算観測の例外はゲームを変えず、元engine拒否は例外のまま、精算は1回。

初回の試作は前述のend→start順序の不備を検出して失敗。IDB検査も、当初の直接store fixtureにlifecycle用closeがなく手前で終了していたため、呼出回数を検査して検出し、fixtureを適切に包んだ。期待値を緩めず、対象故障まで実際に到達させた。

| 今回の検査 | 結果 |
|---|---|
| 全単体npm test | **563件成功（既存544＋新規19）、失敗・スキップ0**。約148.1秒 |
| 接続契約の19単体 | 最終試作でも**19件成功**。実Game/Matchと、遅延/故障の独立呼出側モデル。製品adapterではない |
| lifecycle E2E | **12項目成功** |
| 復旧E2E | **11項目成功** |
| IndexedDB E2E | **21項目成功** |
| Worker E2E | **14項目成功** |
| 記録session E2E | **13項目成功**。既存の12人AI/数学ⅠⅡ×4/8局・32局926判断・24連荘等の検査を再実行 |
| 基礎牌譜E2E | 数学ⅠⅡ×320/390pxの**4条件成功** |
| 既存画面の関連E2E | v06TrioIntegration,v07BeginnerRoom2,v05Riichi,v04Endが**E2E PARTIAL OK**、約117.2秒 |
| 契約試作への故障注入 | 一時コピーで事前endによる見送り迂回/旧scopeガード欠落を検出。2件とも終了コード1。製品コードを故障させた結果とは区別 |
| 構文/保護対象差分/リンク/CI権限 | 成功。src全体/tools/既存play.mjs/packageの変更なし |

[機械可読の結果・ソースhash・実施/未実施区分](validation/v08-integration-readiness.json)。全単体実行後、試作内の精算options受渡しを実session APIのmaxRoundだけへ分離して19件を再実行成功。最終HEADの全単体もCIで再確認する。

システムChromium154.0.8037.57を外部起動ヘルパーで使用。別の2実行方式の成功とは言わない。WebKitバイナリーは存在せず、Safari実機/実quota枯渇/OS kill/総ピークRAMは未検証。今回は設計/独立テストだけで、全体play.mjs・新卓との実接続・I1〜I12は未実行。選定した検査のskipやアサーション弱体化はしていない。今回の失敗注入はNode/独立モジュールであり、将来の実画面adapterへの失敗注入を代替しない。

第6段階の544件/CIを新HEADの成功として流用しない。専用CIは全単体（新規契約検査を含む）/既存の全牌譜ブラウザ検査/性能72操作/関連画面を保持し、テスト試作の構文/変更pathを追加した。contents:read・デプロイなし。push後の新HEADを確認する。

### 統合PRで必須にする検査（今回未実施の将来検査）

| ID | 実際の接続後に行う操作 | 合格条件 |
|---|---|---|
| I1 | タイトル/URL直起動→開始、module遅延/404/parse失敗 | ゲームが起動し、見送りが明示。後付け記録/未処理rejectなし |
| I2 | 記録ON/OFFの同seed・同席・12人AI、数学ⅠⅡ×4/8局 | 全action/events/Game/次AI RNG/精算/最終得点が一致、牌保存/400点 |
| I3 | 手動・AI・auto-pass、ゼロevent pass、鳴き保留/取消し、リーチ、九角無双、流局 | 全判断1回、実牌ID/ツモ/取得と消費/和了/精算が一致。source正確 |
| I4 | 次局連打・再戦31回・reset・タイトル確認取消/確定・相手変更 | 試合/局/observerを混同せず、上限維持、旧通知無効。取消では記録継続 |
| I5 | A保存中→B開始→C見送り→D開始、Aの遅いack/照合 | Cの操作をA/Bへ書かず、AのsavedをB/Dへ表示せず、途中から再接続しない |
| I6 | Worker unavailable/CSP/停止/queue-full、IDB SecurityError/blocked/abort/timeout、quota/論理上限 | ゲームは同じ結果へ進む。保存失敗/不確定を区別し自動retry/削除なし |
| I7 | 2タブ同時更新/相手tab削除、outcome-unknown後の読取り | CASが拒否し、無断再作成/上書き/成功化なし。観測後にも変更があり得る |
| I8 | hidden/pagehide/BFCache/pageshow/再読込/close/OS kill | 最後の確定prefixだけを復元。未保存を完走に補完しない。listener/tick重複なし |
| I9 | double tap/長押し/auto-sort、AI中drag、2段階ヒント・回数・色枠、音/カットイン | 記録通知で手牌DOMを作り直さず、操作/既存AIタイミングを壊さない |
| I10 | 初心者1〜6/設定/タイトル/ローカルdebugと正常試合を往復 | 教材/fixtureを通常牌譜に混入せず、既存localStorage/URL形式不変 |
| I11 | 壊れた/未知版の保存行、停止中の手動削除 | 自動修復/自動消去/空token更新なし。削除の全writer調停未完成を隠さない |
| I12 | 最終結果normal/round-limit、負点、長期連荘、記録8MiB超 | 正式Matchの終了を正とし、記録上限でゲームを切らず、prefix/損失を正しく説明 |

RNGの末端値比較は対局終了後または独立コピーで行い、検査自体が継続中の実Game/AI RNGを進めない。

故障注入はテスト専用context/一時コピーだけ。通常公開サイトのテストフックを増やさない。検査条件の緩和/skip/失敗の成功扱いは禁止。未来の実adapterに同じ失敗注入を当て、試作だけの成功で済ませない。

## 7. iPhone Safari受入票（未実施）

機種・iOS/Safari版・通常/プライベート・縦横/DPR・app/main/PR SHA・seed/席/モード/局数・通信状態を記録する。320/375/390/430px相当と横画面を対象に、少なくとも次を実機で確認する。

1. タイトル・通常開始・URL直起動で初期化の成功/見送りが理解できる。起動/操作が記録の完了待ちにならない。
2. 数学ⅠⅡ×4/8局を完走し、復元結果・牌保存・400点・親連荘/交代・最終結果を照合。
3. 2回tap、長押し、auto-sort、AI中drag、ヒント2段階/色/回数、チー/ポン/ロン/ツモ/リーチ、auto-pass。
4. 保存中の再戦/reset/タイトル、結果→次局。旧試合の通知を新試合へ表示しない。31周期後のWorker/timer/メモリ傾向。
5. ホーム移動/画面ロック/別タブ/電話等の中断→復帰、BFCacheの戻る/進む、再読込。音声の旧音再発も回帰確認。
6. ページclose/OS kill後は最後の確定prefixのみ。未保存分の復元や完走を偽らない。
7. private browsing/Worker不能/IDB利用不可/容量不足で、ゲームを続けられ説明も正しい。利用可能/保持期間は端末依存として記録。
8. オフライン/低速回線のmodule取得失敗。取得済みゲームが動いても未取得Worker/記録moduleが使えるとは限らない。
9. 2タブでの競合/削除は合成データとテストcontextで行い、ユーザーの既存記録を勝手に消さない。
10. 保存説明がノッチ/safe-area/ブラウザバー/操作バー/結果/ヒントを隠さず、文字拡大・VoiceOverでも短文が理解できる。

本物の容量不足を再現できなければ、エラー注入結果と分けて未確認とする。Safari上の強制GC/Worker heap/OS消去を計測できなければ、観察した現象と推定値を区別する。Chromium/WebKitの自動試験をiPhone実機受入の代用にしない。

## 8. 統合後の全体E2E・性能計画

- 新卓mainをbaselineとして、同じ端末・設定・seed/席で記録なし/ありを対比較。Node値とChromium/WebKit/iPhone値を別々に保存する。
- npm test全件、play.mjs全件（headless shellとchannel chromiumを実際に別方式で実行できたか明記）、牌譜/保存/Worker/session/復旧/lifecycleとI1〜I12の実adapter検査。利用可能ならWebKit。ローカルとGitHub CIのHEADを照合する。
- 数学ⅠⅡ×4/8局、24連荘合成fixture、上限近く/超過、31再戦を測定。初回import/factory/Worker起動、before/capture/append、同期postMessage clone、Worker内JSON/全復元/SHA/IDB、全完了、描画間隔/入力応答を分離する。
- p50/p95/最大・50ms超のlong task・rAF間隔・入力取りこぼし・Worker/pending数・Window/Worker/nativeを区別したメモリ・GCの観察を記録。既存の検証を省略して速くしない。
- 実Gameのevent/判断/RNG/精算の不一致、記録に起因する進行不能/入力喪失、資源数の増加、private漏洩は統合停止条件。数値の快適性閾値は実機baselineと対比較を提出してディレクターが決定する。16.7msを全端末60fps保証や既承認の必須値と偽らない。
- 30秒保存の損失は「最後の成功ack以降」。background/容量/競合時の損失上限は保証しない。8MiB超の救済・無制限連荘・ピークRAMは別課題で、既存の性能数値を新卓の実測と呼ばない。

## 9. 将来の統合PRの変更ファイルと手順

| 分類 | 将来のファイル | 方針 |
|---|---|---|
| 基盤 | src/engine/paifu.js、src/ui/paifu-*.js、対応tests/docs/CI | 監査済み基盤を選別して取り込む。既存Game/rules/AI/match/RNGを変更しない |
| 接続 | src/ui/app.js、必要ならsrc/ui/paifu-connection.js | 表の境界に小さい呼出しと世代ガード。connectionは今回未作成。テスト専用harnessを製品からimportしない |
| 最小表示 | 承認後のapp.js/必要最小限styles | 新卓のHTML/CSSを丸ごと旧版で上書きしない。表示位置と通知は別途受入 |
| 総合検査 | tests/e2e/play.mjs、接続専用E2E/単体/性能、既存保存検査 | I1〜I12を実接続で検証。動的import/実Worker/IDB/中断/複数tabの故障を区別 |
| 引継ぎ | 標準5文書、docs/51〜57の続編、機械可読検証 | 最新main/HEAD/実行結果/未受入を追記。過去履歴を削除/古い版で上書きしない |

1. オーナー/ディレクターによるVer.0.7新卓の正式受入・main統合を確認する。PR #36の途中案を無条件に採用しない。
2. その時点の最新mainから新しい統合ブランチ/別Draft PRを作る。PR #37全体をそのままmergeしない。基盤コード/テスト/docsだけを選別し、標準文書は新卓側の新しい記録を優先して追記統合する。
3. mainとPR #37の双方の完全SHAと、既存Game/AI/ルール/RNG/得点/保存/URLのファイル差分を記録。engineVersion文字列だけで同一性を判断しない。既存保存データの自動移行/削除なし。
4. 表の接続境界を新app.jsで再調査して実装。起動直後の見送り、保存表示、退出/復旧/容量のUX未決を先に解決する。
5. 独立差分レビュー、I1〜I12、全単体/全体E2E/性能/実機受入計画を、新しいHEADで実施。重大不具合/競合/必要CI失敗ならDraftで停止する。
6. 将来の統合PRへの正式なマージ/公開権限を確認してから正規手順へ進む。今回の準備指示をマージ/公開承認へ流用しない。
7. 許可された公開後に既存Pagesのdeployと実URLのsmokeを別々に確認。module Workerのサブパス/版混在も確認する。問題時は接続だけ停止できる方針とrevert PRを用意し、ユーザーDB/localStorageをresetしない。

**未解決**：app.js自動接続、実画面の状態通知、明示復旧/競合コピー保全・全tab削除調停、Safari/ピークRAM/GC/OS kill、8MiB超、起動時未readyのUX。これらを完了扱いせず、Ver.0.9/振り返り/共有/新モード/ドラに進まない。
