# Ver.0.8 第5段階：保存復旧の安全性確認・監査

監査開始HEAD：`215af8778671bcf9422042f52da0527cba7217b7`、Draft [PR #37](https://github.com/asumax1128/mathjong/pull/37)。mainは`1603bdf3da18f93737eb6ec52813b6d6ea616eff`。docs/51〜54と最新「ディレクター第4段階判定」を確認。今回もapp.js/卓HTML/CSS/PR #36・既存Game/ルール/数学ⅠⅡ/AI12人/得点/再現URLを変更しない。**Draft保持、mainマージ・公開禁止、Ver.0.9以降に進まない。**

## 1. レビューの独立性・範囲

実装履歴を渡さない読取専用の別Codexエージェント`independent_paifu_audit`に、固定HEADのPR全実装（新牌譜コードク、保存、Worker、session、docs、テスト）をレビューさせた。固定HEADは`/tmp/mathjong-independent-215af877/`へ隔離してNode反例を実行。親担当は独立に反例を再実行し、修正・復旧実装・回帰検査を担当した。

これは**別プロセスのCodexによる別視点レビュー**であり、別人/別モデル/外部組織の監査ではない。監査担当はリポジトリ/Git状態を変更せず、単体/E2E全体を実行した担当とも区別する。レビューはソース/仕様/テストと標的Node再現であり、形式証明や全入力網羅ではない。

対象：記録漏れ（特にゼロevent pass・鳴き保留/取消し）、物理ID/配牌/山/ツモ/リーチ/和了/精算、400点、全判断復元、改ざん/破損/未知版、CAS/削除/途中commit、Worker期限/キュー、秘密情報、leave/flush/stopSaving/新試合の参照。

## 2. 確認済み指摘：P3を2件修正（開始HEADで1件・今回の試作で1件）

### P3-A：fixture snapshotに不存在の物理牌を追加できる

- 対象：開始HEADの`src/engine/paifu.js:137`（initialCheck）。依存先の既存Game.checkInvariantsは整数範囲外の負キー等を配列要素として数えない。
- 再現：数学Ⅰの正常なGameを作り、`g.wall.unshift(-1)`後、origin=fixture/setup=snapshotとしてbeginRound→encode→decode→verifyを実行。
- 期待：不存在IDまたは総枚数超過として拒否。
- 実際：valid:true。物理領域125件に対し実牌124枚。数学Ⅱも169件/168枚。`-0.5`や`"phantom"`も同様。
- 影響：内部fixture/importに限る。通常のsetup=seedは新規Gameとの完全一致検査で元から拒否する。公開対局/得点/AIの主要経路の不具合とは扱わずP3。
- 修正：**新しい牌譜検証モジュールだけ**に、初期wall/handsの配列型・全IDの整数/範囲・枚数・一意性を追加。既存Gameやルール/AIを変更しない。保存スキーマ/DB版も変えない。
- 検証：新規監査テストを隔離した修正前HEADで実行すると、拒否を期待する2件が失敗。修正後は数学ⅠⅡ・builder/import両方で不正IDを拒否し、正常seed/snapshotの往復は成功。

監査担当による修正後の再確認でも、正常記録は維持され、不正IDは拒否された。

### P3-B：旧receiptが不変でも、異なる対局のretry候補を示していた

- 対象：第5段階で追加した`src/ui/paifu-recovery.js`のbaseline-unchanged分岐（中間コミット`c07dd68`）。開始監査HEADにはこのモジュール自体がなく、既存不具合と混同しない。
- 再現：同じIDで数学Ⅰの旧記録/receiptと、数学Ⅱの合法な希望記録を渡す。DBは数学Ⅰの旧receiptから変わっていない。
- 実際：旧receipt一致だけを根拠にrequiresUserDecision:falseと再試行token候補を返した。旧内容の不変は確認できても、希望する履歴がその続きとは証明していない。
- 影響：助言の不備。実書込み・token採用・再開は元から実装していないため、実際の上書き/データ損失は発生しない。監査担当と協議しP3。
- 修正：新しいprefix判定器を足す代わりに保守的に、希望内容が未保存のbaseline-unchangedは常にユーザー判断とし、retry候補tokenを返さない。観測receipt自体は参考情報だが、書込許可を意味しない。
- テスト：同一ID/別モードの独立反例を追加し、既存のbaselineテストも強化。読取後の別タブ更新を、テスト側が別途明示取得した古いtokenによるCASが拒否することも確認する。

追加の確定P0/P1/P2は発見されていない。これを網羅的な欠陥不存在の証明とは扱わない。

### 指摘と区別した設計限界

- initialMatch以前の履歴の真正性やfirstRound/過去親番の起源は、独立の暗号証明ではない。再現URLからの開始は既存validateReplayを必ず通す。検証が保証するのは与えた開始状態以降の合法な判断列/一致で、過去の履歴を復元・認証するものではない。
- private-fullは同一originの私有データで、暗号化/アクセス制御ではない。SHAは署名ではない。
- 任意の途中局面から、将来のAI内部メモリ/RNG位置を含めて同一判断を継続する機能はない。保存した判断によるGame復元を維持する。

## 3. 読み直し・照合だけを行う独立復旧モジュール

`src/ui/paifu-recovery.js`の`inspectPaifuRecovery(evidence,{store})`を追加。通常はprivate Workerの`inspectRecovery`操作から実行する。app.jsやGameへ接続しない。

evidenceは私有のRAM内証拠：

- id、セッション内version、失敗時に実際に投稿したrecord
- expectedToken（初回createはnull）
- 直前に成功ackを得たmetadata全体、またはnull
- failureCode：outcome-unknown / conflict

sessionは失敗したsnapshotと直前receiptを保持する。後から増えた最新recordを失敗時snapshotへすり替えない。成功時に失敗snapshotを解放し、receiptは小さいmetadataだけを保持する。privateRecoveryEvidence()は明示的な私有APIであり、status()/AI/共有へ本文を渡さない。

照合手順：

1. 証拠のID/token/receipt型・版・整合性を確認。失敗時recordを既存encodePaifuで完全検証し、正規JSONとSHA-256を確定。
2. IndexedDBのloadPrivateで実際の行を読み直す。既存の本文/索引/hash/全局面検証を省略しない。
3. 読んだID・token・revision・digest・bytes・mode/status/局数等を確認し、正規化した本文全体も照合。
4. 次表の管理用結果だけ返す。本文/手牌/山順を返さず、writePerformed:false、automaticResume:false、originalWriteConfirmed:falseを明示。

**保存結果の読取り確認と、元transactionの成功/書いた主体の証明は別**。希望内容が見つかっても、別writerが同じ内容を書いた可能性までは否定しない。

| 結果kind | 確認できること | 次の扱い |
|---|---|---|
| attempt-content-present | 希望した全内容が期待する次revisionで存在する | 検証済みコピーの読取り利用は可能。元writeの成功/所有権を断定せず、自動再開しない |
| already-acknowledged | 既知receiptと内容が同一で、希望内容も既にある | 追加書込みは不要。新しいtransactionが成功したとは言わない |
| baseline-unchanged | 既知receiptの全項目が変わらず、希望内容は未保存 | 履歴の続きかは未証明なのでユーザー判断。再試行token候補を返さない |
| same-content-other-writer | 同内容でもCAS競合/想定外revision | writer/競合の判断が必要。勝手にtokenを採用しない |
| conflicting-content | 別の正当な内容が存在 | ユーザー判断。上書き/マージ/切捨てなし |
| changed-under-known-token | 同じtokenのreceiptが既知値と異なる | 契約外の変更としてユーザー判断 |
| missing-initial / missing-after-ack | 行が現在見つからない | 未commitだったのか削除されたのか断定しない。自動再作成なし |
| corrupt / unsupported-version / unavailable等 | 安全に確認できない | 失敗のまま保持。修復/削除/成功化をしない |

自前v1 writerが保存する正規JSONの表現を前提とする。DBを手動変更して非正規JSONを格納した場合等は保守的に照合失敗とし、読み直して勝手に正規化/上書きしない。

## 4. セッション・CASと復旧の境界

- session.inspectRecovery()はin-flightが終わってから、失敗snapshotをWorkerへ渡す。結果を得てもsavedVersion/保存token/pausedを進めず、retrySavingの再照合待ちを解除しない。
- **今回は照合と安全な分類まで**。ユーザー選択UI、token採用、同じセッションへの書込み再開、prefixの自動マージ/新ID化は実装しない。readによるコピーの復旧可能性とwriter再開を混同しない。
- 結果は読取snapshot時点の観測。照合中/照合後にも別タブは更新/削除できる。将来のretryは内容/履歴/権限を別途判断したうえで、必ず観測tokenを使うCASで行い、変更済みなら拒否する。retryWithExpectedTokenは今回常にnullで、照合結果が書込の許可や安全性を保証するものではない。
- 初回createで行がない場合も、削除意図を無視してnull tokenで自動再作成しない。新しい記録IDの作成はユーザー/接続側の別判断。
- ページ終了でRAM上の失敗snapshot/receiptが消えた場合、証拠を推測で補完しない。DBに残った検証済みrecording prefixは読めるが、未保存判断や元writeの帰属は復元できない。
- 新RPCは牌譜行に対して読取専用の追加操作であり、保存行/牌譜/DB版は不変。下位loadPrivateは初回open時に空の専用DB/ストアを初期化することがあるが、復旧照合が牌譜行を追加/更新/削除することはない。writePerformed:falseも牌譜行の変更なしを指す。エラーに本文や例外全文を含めず、ネット送信・AI入力・公開共有も追加しない。

## 5. 異常系・資源・実機の境界

- 複数タブ：実際の別PageからCAS更新/削除し、希望内容と違う記録が残ること、同内容でもwriter競合になること、読取後の古いretryがCAS拒否されることを検査する。
- 背景化：Chromium CDPのページfreeze/activeを利用。未要求の保存を捏造せず、前景の明示tick/flushで保存する。Safariのブラウザバー/実際のOS背景化を検証したという意味ではない。
- ページ終了：最後の確定済みprefixだけ保持。保存済みでない操作をcomplete/和了/精算に補完しない。書込途中のタブ終了/Worker終了は既存E2Eも維持。
- 連続再戦相当：新IDのGame/セッション作成→記録→reset退出→flush→disposeを31回検査。これは独立モジュールの寿命検査であり、通常UIの再戦連打に実接続したものではない。
- 長期対局：既存24連荘・数学ⅠⅡ×4/8局、400点・牌保存、4000判断/64局の記録上限、8MiB/20件/32MiBを維持。無制限連荘の完全保存/厳密RAM上限は保証しない。
- 容量不足：自動削除せず、保存pausedとメモリ記録継続を維持。実ディスクを枯渇させる試験ではなく、native error注入と論理上限を区別する。
- 終了中sessionのアプリ全体の上限は未実装。active 1＋終了処理中1等の案と、新しいGameを止めず記録だけ見送る方針はdocs/54から維持。今回のdispose順守テストだけで上限実装済みとは扱わない。
- Safari/WebKit、プライベートブラウズ、OSによる消去/kill、Worker/native IDBを含むピークRAM、長時間GCは未検証。前景30秒方式の損失上限は未保証。

## 6. テスト結果

最終実行後に実数を追記する。監査担当の標的再現と、実装担当の単体/ブラウザ回帰を区別する。過去の470件やCIを新HEADの成功に流用しない。

## 7. 次のゲート

1. この差分の独立再確認とSafari/WebKitの受入計画。
2. 照合後の明示操作/通知、競合する二つのコピーの保全、削除/新ID化/再開の権限設計。
3. 終了中sessionの上限・参照解放・背景/終了時の接続仕様と実機メモリ測定。
4. Claude Code担当Ver.0.7卓UIの正式受入後、app.js接続は別PR/別ゲートで判断。

今回の結果を理由にmainマージ・公開・Ver.0.9以降の開発へ進まない。旧文書は履歴として保持する。
