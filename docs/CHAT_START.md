# 数雀｜新チャットでのGitHubからの復元入口

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
5. オーナーが決定した表記変更予定：かなたの一覧紹介「冷静に待ちを見る」、かおるの一覧紹介「ヨイショの達人」、ふくやまの表示名「シャカ」。fukuyama内部IDとAIロジックは維持。変更の実装・公開有無は現在のコードで確認し、文書だけで実装済みと判定しない。
6. 優先順位：①GitHub引き継ぎ基盤最新化 ②初心者の部屋 ③戦績・対戦記録 ④新キャラ3人追加（計12人） ⑤デフォルメイラスト追加。
7. PR #11（引き継ぎ資料）とPR #18（表示修正）はmainマージ済み。PR #19（初心者の部屋の第4〜6段階の設計・承認済み）はDraft・未マージ。第4〜6段階の実装はブランチ feature/beginner-room-lesson4to6 のDraft PR（docs/36）で、未マージ・未公開。PR #6も保留。残存P3（旧ツールcalibrate-advanced.mjsのAUC同点処理）と中級/上級の強さの近さは、正式完成を阻止しない継続課題。
8. 旧資料docs/01・05・09・12・18の古い試作記述を、現在の実装と誤認しない。
9. 未承認の仕様や実施していないテストを完了済みと報告しない。

報告は「最新main SHA・公開版・PRの状態／正式完成と実機根拠／新しい決定と実装状況の差／未解決事項／次の優先作業／出典リンク」の順で示し、GitHubの変更は明示承認を得た範囲で行ってください。
```

## 証拠と基準

- Ver.0.6のマージコミット：`484150efc303f82e1255a5cc4feaf31cfee9c4b9`。その後の文書更新後の基準：`296b3d6855ec0f190be6493d2cca79cc3d5b73fc`（**この更新時点のみ**）。
- PR #17：<https://github.com/asumax1128/mathjong/pull/17>（merged）
- PR #11：<https://github.com/asumax1128/mathjong/pull/11>（mainマージ済み）
- PR #18：<https://github.com/asumax1128/mathjong/pull/18>（表示修正・mainマージ済み）
- PR #19：<https://github.com/asumax1128/mathjong/pull/19>（初心者の部屋・設計案・Draft）
- 初心者の部屋 第4〜6段階の実装：ブランチ `feature/beginner-room-lesson4to6` のDraft PR（[docs/36](36-beginner-room-lessons4to6.md)・未マージ・未公開）
- Ver.0.6公開・実機完了： [docs/32](32-ver0.6-free-select-release.md)
- 画面の最新仕様：[現状引き継ぎ](HANDOFF.md) / [決定記録](DECISIONS.md) / [ロードマップ](ROADMAP.md) / [運用](WORKFLOW.md)

## 引き継ぎ確認の合格条件

GitHubだけを読んだ新チャットが、現在の正式版・SHA・PR #11/#18のマージ済み状態・PR #19のDraft状態・9人のAI・優先順位・P3を復元できること。独立復元テストは未実施。
