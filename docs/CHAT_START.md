# 数雀｜新チャットでのGitHubからの復元入口

> **最新公開（2026-10-29）：数雀 Ver.0.6.4**。オーナーの指示で「ゆうじん」の一覧の一言を **「鳴かずに刻子を育てる」→「刻子大好き」** に変更。表示用 `PROFILES.yujin.trait` と `TRIO_ROSTER` の `styleLabel` のみ（AI判断、刻子重視・鳴かない打ち方、ほか11名、ゲームルール、保存・PRNGは不変）。[PR #30](https://github.com/asumax1128/mathjong/pull/30) HEAD `6c77b12a0a84a430f880a95ca2186f06624f6a25` 必須CI2件Success後、main `e0db390858c9c7efe2ecc9558652ed144443d2cd` に正規マージ。[Pages run 40791462358](https://github.com/asumax1128/mathjong/actions/runs/40791462358)、[公開通常smoke run 40791509868](https://github.com/asumax1128/mathjong/actions/runs/40791509868)で新文言合格、[初心者の部屋1〜6公開E2E run 40791509859](https://github.com/asumax1128/mathjong/actions/runs/40791509859)はすべてSuccess。[仕様 docs/44](44-ver0.6.4-yujin-tagline.md)。**Ver.0.6.4のオーナーiPhone Safari実機確認は未報告**。画像はVer.0.6.3と同様、一覧に表示せず詳細限定。PR #19はDraftのまま変更しない。

> **前版の公開記録（2026-10-29）：数雀 Ver.0.6.3**。オーナーが提示したiPhone Safari画面を受けて、新3名の「ゆ／た／の」と「仮表示」の仮画像を一覧から削除、詳細の準備中告知も削除。**12人の一覧は全端末で名前・難易度・特徴・選択チェックのみ。今後の正式イラストはスマホでは詳細を開いた時のみ閲覧できる**（実装上PCも一覧では画像を生成しない）。[PR #28](https://github.com/asumax1128/mathjong/pull/28) HEAD `e7a8171d297d02018376baccec2d7516c614e23c`、必須CI2件Success、mainマージ `9ae78cf97be6add41e8799fd0b066ba2298e5be4`。[Pages run 40786901639](https://github.com/asumax1128/mathjong/actions/runs/40786901639)、[公開通常smoke run 40786948418](https://github.com/asumax1128/mathjong/actions/runs/40786948418)、[初心者の部屋1〜6公開E2E run 40786948313](https://github.com/asumax1128/mathjong/actions/runs/40786948313)はすべてSuccess。[仕様 docs/43](43-ver0.6.3-opponent-list-text-only.md)。既存9人・新3名のAI、数学Ⅰ/Ⅱのルール、保存形式は不変。**Ver.0.6.3のiPhone実機再確認は未報告**。新規イラストの採用・実装は今回の対象外。

> **前版の公開記録（2026-10-29）**：数雀 Ver.0.6.2（12人選択、ゆうじん26歳初級／たら25歳中級／のっち28歳上級、初中上各4人の順に表示）。[PR #27](https://github.com/asumax1128/mathjong/pull/27) HEAD `b1ff774bfcdc3b8408a4d812d2ea7389c0249249`、必須CI2件Success、mainマージ `627081240c3b9c9907adbf96061a6fcd71b81f2d`。[Pages 40781902816](https://github.com/asumax1128/mathjong/actions/runs/40781902816)、[公開通常対局smoke 40782005883](https://github.com/asumax1128/mathjong/actions/runs/40782005883)、[公開初心者教材E2E 40782005997](https://github.com/asumax1128/mathjong/actions/runs/40782005997)すべてSuccess。**Ver.0.6.2のiPhone実機表示確認は未実施**。ゲームルール、AI判断・係数、旧9人の内部ID、保存形式は不変。[変更仕様docs/42](42-ver0.6.2-trio-profiles.md)。

> **正式な実機受入の区別**：Ver.0.6.1（新3名の本体統合、12人選択）はオーナーが2026-10-29にiPhone Safariで**8/8項目合格**を報告。[受入記録docs/41](41-ver0.6.1-release-acceptance.md)。[PR #24](https://github.com/asumax1128/mathjong/pull/24) は `6d254a56b92a3c041d1e1ffe5c2716a887179c57` でmerged。本受入をVer.0.6.2の実機合格として流用しない。正式画像は引き続き頭文字の仮表示。

> **初心者教材の公開検査**：[PR #25](https://github.com/asumax1128/mathjong/pull/25) は必須CI2件Success後に `a686f69fd0c764737526833062b6f4da157894c9` にmerged。Pages・通常smoke・初心者の部屋1〜6公開E2EもSuccess。Ver.0.6.2でも公開E2E successを再確認。**PR #19は設計資料のDraftとして変更・マージしない**。最新状態が下記の記録時点のPR・SHAと異なる場合は必ず現在のGitHubを優先する。

> **2026-10-28の包括承認（D16）**：既存仕様内は安全条件を満たせばCodexが追加承認なしで実装・Ready・正規mainマージ・既存Pages公開まで進める。重大なルール変更・破壊的データ変更・重大なセキュリティ変更は相談。CI・保護・通信制限を迂回しない。PR #19は自動マージ対象外。

> 2026-10-28 更新。リポジトリ：<https://github.com/asumax1128/mathjong>。
> **PR #11で2026-10-28にmainへマージ済み**。最新状態はGitHubで確認する。
> 次のチャットで必ずGitHubの最新main HEAD、PR一覧、版番号を再取得し、以下の基準SHAを現在値と誤認しない。

## 新チャットにそのままコピーするプロンプト

```text
あなたは数雀（MATHJONG）の開発ディレクターです。
GitHubリポジトリ https://github.com/asumax1128/mathjong を一次資料として引き継いでください。

必ず次の順に実施してください。
1. 最新のmain HEAD SHA、公開版、src/ui/app.jsのAPP_VERSION、src/engine/config.jsのENGINE_VERSION、開いているPRとDraft/merged状態をGitHubで調べる。
2. mainの docs/CHAT_START.md → docs/HANDOFF.md → docs/DECISIONS.md → docs/ROADMAP.md → docs/WORKFLOW.md を読む。PR #11はmainマージ済み。
3. docs/32-ver0.6-free-select-release.md（Ver.0.6正式完成・iPhone Safari 30/30合格）、docs/25〜31（9人AI設計・監査・検証）、READMEを参照し、現行の実装と古いdocsの履歴を分ける。
4. Ver.0.6：9人から3人選択（おまかせ、一様な座席、詳細、同じ3人と再戦）、数学Ⅰ・Ⅱ、4/8局戦が正式完成。PR #17は2026-10-28にmainマージ。既存の公開URL https://asumax1128.github.io/mathjong/ のみを使う。
5. PR #18でmainに反映済みの表記：かなたの一覧紹介「冷静に待ちを見る」、かおるの一覧紹介「ヨイショの達人」、旧表示名ふくやまは「シャカ」。fukuyama内部IDとAIロジックは維持。公開サイトの表示確認とコード上の実装確認を区別する。
6. 最新の実態：12人の自由選択と新3名のAIはVer.0.6.1で公開・iPhone Safari実機8/8合格。Ver.0.6.2は3名の年齢・難易度を設定し、初中上各4人へ並び替えてmainマージ・Pages公開・公開smoke・公開教材E2Eが成功。Ver.0.6.2自体のiPhone実機表示受入は未実施。docs/41・42および本ファイル冒頭を優先する。
7. PR #11/#18/#20/#21はmainマージ済み。PR #21後の記録時点mainは ce659038eadc7b7838dd6659808a088a49d29a76。PR #22の修正HEAD fdcfcd4 の公開入口smokeは3件Success。PR #22/#23は記録時点でDraft・未マージ。API接続がCodex環境で403のためReady化・正規マージは未実行。公開全段階テスト追加ブランチ test/public-beginner-room-smoke は別途検証中。第4〜6段階の実機受入は未実施。新3キャラは2,608試合を経て統合候補ブランチで実装・ローカル検証済み。docs/40を参照し、通信反映後に正規CI・マージ・公開確認へ進む。詳細はHANDOFF 4.3。PR #19/#6や残存P3は別管理。
8. 旧資料docs/01・05・09・12・18の古い試作記述を、現在の実装と誤認しない。
9. 未承認の仕様や実施していないテストを完了済みと報告しない。

報告は「最新main・PR状態／公開と実機受入の区別／変更と根拠／未解決事項／次の作業」。包括承認内は毎回の承認待ちをせず、安全条件を満たしてからマージする。実装者自身の再確認と別担当者の独立監査を区別し、未実施を完了としない。
```

## 証拠と基準

- Ver.0.6のマージコミット：`484150efc303f82e1255a5cc4feaf31cfee9c4b9`。その後の文書更新後の基準：`296b3d6855ec0f190be6493d2cca79cc3d5b73fc`（**この更新時点のみ**）。
- PR #17：<https://github.com/asumax1128/mathjong/pull/17>（merged）
- PR #11：<https://github.com/asumax1128/mathjong/pull/11>（mainマージ済み）
- PR #18：<https://github.com/asumax1128/mathjong/pull/18>（表示修正・mainマージ済み）
- PR #19：<https://github.com/asumax1128/mathjong/pull/19>（初心者の部屋・設計案・Draft）
- 初心者の部屋 第4〜6段階：[PR #21](https://github.com/asumax1128/mathjong/pull/21)は2026-10-28 11:39:43 UTCにmerged、main `ce659038eadc7b7838dd6659808a088a49d29a76`。[Pagesデプロイ成功](https://github.com/asumax1128/mathjong/actions/runs/40681686192)と[公開smoke test失敗](https://github.com/asumax1128/mathjong/actions/runs/40681741442)は別の結果。詳細は[docs/36](36-beginner-room-lessons4to6.md)。
- Ver.0.6公開・実機完了： [docs/32](32-ver0.6-free-select-release.md)
- 画面の最新仕様：[現状引き継ぎ](HANDOFF.md) / [決定記録](DECISIONS.md) / [ロードマップ](ROADMAP.md) / [運用](WORKFLOW.md)

## 引き継ぎ確認の合格条件

GitHubだけを読んだ新チャットが、現在の正式版・main SHA・PR #11/#18/#20/#21のマージ済み状態・PR #19のDraft状態・公開smokeの未解決事項と保守ブランチ・第4〜6段階の実機受入待ち・9人のAI・優先順位・P3を復元できること。独立復元テストは未実施。
