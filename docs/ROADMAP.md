# 数雀｜現行ロードマップ（実績と計画を分離）

> **最新公開（2026-10-29）：数雀 Ver.0.6.4**。オーナー指示でゆうじんの一覧紹介を**「鳴かずに刻子を育てる」→「刻子大好き」**へ変更。PR [#30](https://github.com/asumax1128/mathjong/pull/30) HEAD `6c77b12a0a84a430f880a95ca2186f06624f6a25` を必須CI2件Success後、main `e0db390858c9c7efe2ecc9558652ed144443d2cd` に正式マージ。[Pages 40791462358](https://github.com/asumax1128/mathjong/actions/runs/40791462358)、[公開通常対局smoke 40791509868](https://github.com/asumax1128/mathjong/actions/runs/40791509868)、[初心者の部屋1〜6公開E2E 40791509859](https://github.com/asumax1128/mathjong/actions/runs/40791509859)はすべてSuccess。表示用 `trait` と `styleLabel` 以外のAI・ルール・保存・選択順は無変更。Ver.0.6.3からの**一覧画像なし・イラストは詳細限定**も維持。[詳細 docs/44](44-ver0.6.4-yujin-tagline.md)。**Ver.0.6.4のiPhone Safari実機受入は未報告**。

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
| **5** | **キャラクターイラスト** | 未制作 | 正式採用後は**一覧には一切表示しない**。スマホは詳細を開いた時のみ表示（PCも一覧は画像なし） |

### main反映済みの文言修正（PR #18、#30）

- かなた：一覧一言 **「冷静に待ちを見る」**
- かおる：一覧一言 **「ヨイショの達人」**
- ゆうじん：一覧一言 **「刻子大好き」**（旧「鳴かずに刻子を育てる」、PR #30、Ver.0.6.4）
- ふくやま：表示名 **「シャカ」**（内部ID `fukuyama` 維持）

かなた・かおる・シャカの変更は[PR #18](https://github.com/asumax1128/mathjong/pull/18)、ゆうじんの一言変更は[PR #30](https://github.com/asumax1128/mathjong/pull/30)で、それぞれ必須CI成功後にmainマージ済み。Ver.0.6.4のPages・公開smokeはSuccess、iPhone Safari実機再確認は未報告（docs/44）。

## 技術的保守・未承認の将来案

- 旧`tools/calibrate-advanced.mjs`のAUC同点P3。実行上の重大障害ではない。
- 中級と上級AIの強さの差は実測上小さめ。個性を破壊する能力値調整を自動で始めない。
- 本格4人人間オンライン、関数ドラ、フリテン、追加の数式体系などは別途検討。具体仕様とマージには承認が必要。

## 品質と完了の定義

**範囲確認→専用ブランチ/Draft PR→実装・テスト・差分再点検→D16の安全条件確認→自律Ready/正規mainマージ→既存Pagesデプロイ・公開検査→iPhone Safari実機受入→正式完成**。新サイトを作らず、条件未達を迂回しない。重大な仕様変更は相談する。
