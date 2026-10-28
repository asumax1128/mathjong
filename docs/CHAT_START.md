# 数雀｜新チャットでのGitHubからの復元入口

> **最新確認：2026-10-29 / 数雀 Ver.0.6.1 公開済み**。GitHub main `6d254a56b92a3c041d1e1ffe5c2716a887179c57`。PR #24（ゆうじん・たら・のっち／12人選択）は HEAD `67f282a8d84a21647f901b834fd5414b32ddf256` でCI3件Success後に正式merged。既存Pagesの[デプロイ 40772371683](https://github.com/asumax1128/mathjong/actions/runs/40772371683)と[公開smoke 40772469585](https://github.com/asumax1128/mathjong/actions/runs/40772469585)もSuccess。公開URLは https://asumax1128.github.io/mathjong/ のまま。既存9名、ゲームルール、保存形式、エンジン版0.5.0-aは不変。

> **直近の未完了作業**：PR #25（公開初心者教材E2E）はbaseを `main` に変更済み、HEAD `59d4cec098659ce19484d2b9467cf63a39215fc9`、差分は公開E2E関連5ファイルのみ。初心者教材CIはSuccessだがAI benchmarkはこの文書更新の確認時点で実行中。必須CIのSuccessを確認後、競合・HEADを再点検し、条件が整えば包括承認D16に従ってmainへマージする。新ワークフローの実サイトE2E成功は未確認。PR #19はDraftのまま変更しない。

> **iPhone Safari受入は別**：Ver.0.6の30/30、初心者の部屋1〜3の7/7は既存の成功記録。Ver.0.6.1の新3名・12人版および初心者の部屋4〜6のiPhone Safari実機検証は未実施。公開自動テストの成功を実機合格と記録しない。以下の古いスナップショット/PR状態に関する記述より、本欄と現在のGitHubを優先する。

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
6. 優先順位：①GitHub引き継ぎ基盤最新化 ②初心者の部屋 ③戦績・対戦記録 ④新キャラ3人追加（計12人） ⑤デフォルメイラスト追加。
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
