# 数雀｜現行ロードマップ（実績と計画を分離）

> **2026-10-29 PR #34開発再開**：unavailable前の未コミット変更を保全し、スマホ縦は手牌下のヒント、タブレット横は左約62%の卓／右約38%の学習領域を実装し、単体379件・11画面E2E・全体E2E（793.345秒）がローカルで成功。[docs/46](46-v07-table-hint-dock.md)。最新指示はPRへのpushとCI確認までで、**mainマージ・Pages公開は禁止**。本番は引き続きVer.0.6.4、Ver.0.7の実機受入は未実施。
> **次期開発方針（オーナー承認：2026-10-29）**：Ver.0.7は対局UIを本格麻雀卓寄りに刷新するが、**画面下のスペースは削らず既存の2段階ヒント・数式確認専用エリア**にする。以後は牌譜基盤→振り返り・戦績→一局勝負・何切る→詰め数雀・大会→高度牌譜分析の順。正式仕様と品質ゲートは[docs/45](45-v07-v11-roadmap.md)。**計画であって実装・公開済みという意味ではない**。


> **最新公開（2026-10-29）：数雀 Ver.0.6.4**。オーナーの指示で「ゆうじん」の一覧の一言を **「鳴かずに刻子を育てる」→「刻子大好き」** に変更。表示用 `PROFILES.yujin.trait` と `TRIO_ROSTER` の `styleLabel` のみ（AI判断、刻子重視・鳴かない打ち方、ほか11名、ゲームルール、保存・PRNGは不変）。[PR #30](https://github.com/asumax1128/mathjong/pull/30) HEAD `6c77b12a0a84a430f880a95ca2186f06624f6a25` 必須CI2件Success後、main `e0db390858c9c7efe2ecc9558652ed144443d2cd` に正規マージ。[Pages run 40791462358](https://github.com/asumax1128/mathjong/actions/runs/40791462358)、[公開通常smoke run 40791509868](https://github.com/asumax1128/mathjong/actions/runs/40791509868)で新文言合格、[初心者の部屋1〜6公開E2E run 40791509859](https://github.com/asumax1128/mathjong/actions/runs/40791509859)はすべてSuccess。[仕様 docs/44](44-ver0.6.4-yujin-tagline.md)。**Ver.0.6.4のオーナーiPhone Safari実機確認は未報告**。画像はVer.0.6.3と同様、一覧に表示せず詳細限定。PR #19はDraftのまま変更しない。

> **前版の公開記録（2026-10-29）：数雀 Ver.0.6.3**。オーナーが提示したiPhone Safari画面を受けて、新3名の「ゆ／た／の」と「仮表示」の仮画像を一覧から削除、詳細の準備中告知も削除。**12人の一覧は全端末で名前・難易度・特徴・選択チェックのみ。今後の正式イラストはスマホでは詳細を開いた時のみ閲覧できる**（実装上PCも一覧では画像を生成しない）。[PR #28](https://github.com/asumax1128/mathjong/pull/28) HEAD `e7a8171d297d02018376baccec2d7516c614e23c`、必須CI2件Success、mainマージ `9ae78cf97be6add41e8799fd0b066ba2298e5be4`。[Pages run 40786901639](https://github.com/asumax1128/mathjong/actions/runs/40786901639)、[公開通常smoke run 40786948418](https://github.com/asumax1128/mathjong/actions/runs/40786948418)、[初心者の部屋1〜6公開E2E run 40786948313](https://github.com/asumax1128/mathjong/actions/runs/40786948313)はすべてSuccess。[仕様 docs/43](43-ver0.6.3-opponent-list-text-only.md)。既存9人・新3名のAI、数学Ⅰ/Ⅱのルール、保存形式は不変。**Ver.0.6.3のiPhone実機再確認は未報告**。新規イラストの採用・実装は今回の対象外。

> **前版の公開記録（2026-10-29）**：数雀 Ver.0.6.2（12人選択、ゆうじん26歳初級／たら25歳中級／のっち28歳上級、初中上各4人の順に表示）。[PR #27](https://github.com/asumax1128/mathjong/pull/27) HEAD `b1ff774bfcdc3b8408a4d812d2ea7389c0249249`、必須CI2件Success、mainマージ `627081240c3b9c9907adbf96061a6fcd71b81f2d`。[Pages 40781902816](https://github.com/asumax1128/mathjong/actions/runs/40781902816)、[公開通常対局smoke 40782005883](https://github.com/asumax1128/mathjong/actions/runs/40782005883)、[公開初心者教材E2E 40782005997](https://github.com/asumax1128/mathjong/actions/runs/40782005997)すべてSuccess。**Ver.0.6.2のiPhone実機表示確認は未実施**。ゲームルール、AI判断・係数、旧9人の内部ID、保存形式は不変。[変更仕様docs/42](42-ver0.6.2-trio-profiles.md)。

> **正式な実機受入の区別**：Ver.0.6.1（新3名の本体統合、12人選択）はオーナーが2026-10-29にiPhone Safariで**8/8項目合格**を報告。[受入記録docs/41](41-ver0.6.1-release-acceptance.md)。[PR #24](https://github.com/asumax1128/mathjong/pull/24) は `6d254a56b92a3c041d1e1ffe5c2716a887179c57` でmerged。本受入をVer.0.6.2の実機合格として流用しない。正式画像は引き続き頭文字の仮表示。

> **初心者教材の公開検査**：[PR #25](https://github.com/asumax1128/mathjong/pull/25) は必須CI2件Success後に `a686f69fd0c764737526833062b6f4da157894c9` にmerged。Pages・通常smoke・初心者の部屋1〜6公開E2EもSuccess。Ver.0.6.2でも公開E2E successを再確認。**PR #19は設計資料のDraftとして変更・マージしない**。最新状態が下記の記録時点のPR・SHAと異なる場合は必ず現在のGitHubを優先する。

> **2026-10-28の包括承認（D16）**：既存仕様内は安全条件を満たせばCodexが追加承認なしで実装・Ready・正規mainマージ・既存Pages公開まで進める。重大なルール変更・破壊的データ変更・重大なセキュリティ変更は相談。CI・保護・通信制限を迂回しない。PR #19は自動マージ対象外。

> 2026-10-28整理。旧[docs/09](09-roadmap.md)は2026-10-24時点の歴史的な企画であり、旧M0〜M6の未チェック欄を現在の未実装一覧とみなさない。

## 正式完成・公開済み

| 版 | 実績 | 受入 |
|---|---|---|
| Ver.0.1〜0.2 | 4人麻雀風Web版、ガイド、ヒント/ドラッグ等 | 版別記録 |
| Ver.0.3-A/B | 数学Ⅰ・Ⅱ、刻子/ポン、2段階ヒント | 版別記録 |
| Ver.0.4-A/B | 4/8局戦・親子精算、難易度AI、チー/ポン自動パス | PR #10、iPhone Safari実機7/7合格（2026-10-26） |
| Ver.0.5-C/D/E | タイトルロゴ、カットイン、効果音、ボイス準備 | [Ver.0.6完成記録](32-ver0.6-free-select-release.md) |
| **Ver.0.6** | **9人の個別AI、3人自由選択、84通りおまかせ、座席抽選、キャラ詳細、再戦** | **PR #17 merged、345/345単体、111項目E2E、iPhone Safari実機30/30合格（2026-10-28）** |

## オーナー指定の今後の順序

| 順位 | テーマ | 現状 | 次の明確な作業 |
|---|---|---|---|
| **1** | **GitHubの最新化・永続引き継ぎ** | PR #11はmainマージ済み | 新チャットからの独立復元テストを実施する |
| **2** | **初心者の部屋** | PR #20/#21で全6段階をmain反映、Pages成功。PR #22修正ブランチの公開入口smokeは3件成功。**第1〜3段階のみ実機7/7合格、第4〜6段階は未受入**。PR #19はDraft維持 | API復旧後にPR #22/#23を安全条件付きで処理。直接URL E2E追加ブランチを検証・公開し、実際のPagesで実行する。その後iPhone受入。HANDOFF 4.3参照 |
| **3** | **戦績・対戦記録** | 未実装 | 指標と端末内保存/削除・復元条件を設計 |
| **4** | **新キャラクター3人** | **Ver.0.6.1 iPhone8/8受入、Ver.0.6.2の年齢・難易度整理と公開、Ver.0.6.3の仮表示除去をmain統合済み** | Ver.0.6.3のiPhone表示確認、正式イラストは別途採用（スマホ一覧では表示しない） |
| **5** | **デフォルメイラスト** | 未制作 | 一覧でデフォルメ、詳細では通常頭身という将来構想の扱いを再確認 |

### main反映済みの文言修正（PR #18）

- かなた：一覧一言 **「冷静に待ちを見る」**
- かおる：一覧一言 **「ヨイショの達人」**
- ふくやま：表示名 **「シャカ」**（内部ID `fukuyama` 維持）

表示変更は[PR #18](https://github.com/asumax1128/mathjong/pull/18)でCI2件成功後に**mainマージ済み**。公開サイトの配信・iPhone表示は別途確認する。

## 技術的保守・未承認の将来案

- 旧`tools/calibrate-advanced.mjs`のAUC同点P3。実行上の重大障害ではない。
- 中級と上級AIの強さの差は実測上小さめ。個性を破壊する能力値調整を自動で始めない。
- 本格4人人間オンライン、関数ドラ、フリテン、追加の数式体系などは別途検討。具体仕様とマージには承認が必要。

## 品質と完了の定義

**範囲確認→専用ブランチ/Draft PR→実装・テスト・差分再点検→D16の安全条件確認→自律Ready/正規mainマージ→既存Pagesデプロイ・公開検査→iPhone Safari実機受入→正式完成**。新サイトを作らず、条件未達を迂回しない。重大な仕様変更は相談する。

### Ver.0.6.4表示文言の整理（2026-10-29）

ゆうじん一覧の一言を「刻子大好き」に変更済み（PR #30、Pages/通常smoke/初心者公開E2E Success）。AIバランス変更はない。次は必要に応じてiPhone Safari上の表示確認。正式イラストは別途採用、スマホ一覧には表示しない。

## 次期開発計画（D24・オーナー承認、2026-10-29）

**現行の旧優先順位は履歴**。今後は[docs/45](45-v07-v11-roadmap.md)のVer.0.7→0.8→0.9→1.0→1.1→高度牌譜分析を優先する。特にVer.0.7は参考麻雀卓に寄せつつ下の余白を**2段階ヒントと数式確認の専用表示領域**にする。旧版の「一覧にデフォルメイラスト」構想は取り消し、正式イラストはスマホのキャラ詳細のみ（docs/43）。いずれも未実装の計画を完成済みとして扱わない。


## 2026-10-29 追記：Ver.0.8牌譜基盤の先行開発（未統合）

最新指示[docs/50](50-v08-paifu-foundation-kickoff.md)に基づき、Codexは`feature/v08-paifu-foundation`でUIから独立した版付き記録・復元・検証を開発。[調査・スキーマ・API・未決定事項](51-v08-paifu-foundation-schema.md)。通常対局への自動記録接続、保存媒体、公開・共有、Ver.0.9以降の画面は未実装。Ver.0.7の卓UIはClaude Code担当であり、PR #36のブランチには触れない。今回の指示ではDraft保持、mainマージ・Pages公開は禁止。従来の包括公開承認を今回へ流用しない。既存の決定・履歴は保持。


## 2026-10-29 追記：Ver.0.8 第2段階の保存基盤（Draft #37）

PR #37の開始HEAD `3f1344f`と専用CI [40860681346](https://github.com/asumax1128/mathjong/actions/runs/40860681346)のSuccessを確認後、独立IndexedDB保存アダプターを追加。[DB構造・API・容量・異常系・性能・未完成事項](52-v08-paifu-indexeddb.md)。既存localStorage/エンジン/AI/UI/再現URLは不変。自動記録・自動保存への接続はしない。PR #36に触れず、PR #37はDraft、mainマージ・Pages公開は禁止。新HEADのチェックは開始HEADのSuccessと区別する。既存履歴は保持。


## 2026-10-29 追記：Ver.0.8 第3段階 Worker復旧・独立試作

第2段階HEAD `cf1a419`から未コミット6ファイルとログを回収・アーカイブし、保全コミット`2e7a1f8`をPR #37へpush。[復旧・性能比較・API・検証結果・制限](53-v08-worker-recovery-performance.md)を参照。既存DB/牌譜/保存キー/再現URLと全復元検証を保持した専用Worker＋有界FIFOを試作。総完了時間は短縮せず、画面側の重い処理を減らす方式。通常対局未接続、PR #37 Draft維持、mainマージ・Pages公開禁止。PR #36/卓UI/既存エンジン/AI/得点は変更しない。新HEADのCIを確認し、過去のSuccessを流用しない。既存履歴は保持。


## 2026-10-29 追記：Ver.0.8 第4段階の接続設計・独立制御

第3段階HEAD `fcdfdaf`とディレクター完了判定を確認し、[接続点・failure isolation・保存頻度・独立制御モジュール・未完成事項](54-v08-auto-recording-connection.md)を追加。全判断のメモリ記録と、Worker保存時点の集約を分離する。app.js/卓UI/既存エンジン/12人AI/保存形式/URLは変更せず、通常対局へ未接続。PR #37はDraft、mainマージ・Pages公開禁止、PR #36には触れない。過去のCIを新HEADへ流用せず、新HEADで専用CIを確認する。既存履歴は保持。


## 2026-10-29 追記：Ver.0.8 第5段階の監査・読取専用復旧照合

固定HEAD `215af87`を実装履歴なしの別Codexエージェントで読取レビューし、fixture/importの不存在物理ID受理P3を再現。新牌譜validatorのみで厳密化し、既存Game/ルール/AI/得点は維持。[監査・修正・読取照合・テスト・限界](55-v08-recovery-audit.md)を参照。outcome-unknown/CAS競合のID/token/digest/全内容を読み直すが、元writeの成功証明・token採用・自動retry/上書き/削除/再開はしない。app.js/卓UI/既存保存形式/URLは不変。通常対局未接続、PR #37 Draft維持、mainマージ・公開禁止。別人/別モデルの外部監査やSafari合格とは扱わず、過去CIを新HEADへ流用しない。


## 2026-10-30 JST 追記：Ver.0.8 第6段階のセッション資源・保存状態

[docs/56](56-v08-session-lifecycle.md)を参照。active最大1＋終了中最大1の独立調停と、私有データを含まない保存状態の純粋な説明関数を追加。飽和時はゲームを止めず新試合の記録だけ見送り、未保存損失を隠さない。読取り照合は事実確認のみで、自動retry/上書き/削除/token採用/再開なし。通常対局・app.js・卓UIへ未接続。既存エンジン/12人AI/得点/保存形式/URLとPR #36は不変。Draft #37維持、mainマージ・Pages公開・Ver.0.9以降は禁止。従来の履歴/CIを新HEADの実績へ流用しない。Safari/総ピークRAM/OS kill/ユーザー判断による保全・復旧は別ゲート。
