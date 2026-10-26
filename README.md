# MATHJONG（数式麻雀）

三角関数の値を利用する**4人対戦の数学麻雀**。開発企画・試作ルール・シミュレーションの記録を保存するリポジトリです。

> **最新の正式完成版：Ver.0.4-B（2026-10-26、main反映・オーナーiPhone Safari実機7/7合格）**。画面版`0.4.0-b`。本書の後半には初期企画の歴史的なシミュレーション数値も保存しています。**現在の仕様と進行は[HANDOFF](docs/HANDOFF.md)を優先。**

## 新しいチャット／開発者の入口

**[CHAT_START.md](docs/CHAT_START.md) → [HANDOFF.md](docs/HANDOFF.md) → [DECISIONS.md](docs/DECISIONS.md) → [ROADMAP.md](docs/ROADMAP.md) → [WORKFLOW.md](docs/WORKFLOW.md)**。

これらはPR #11の文書ブランチで整備中の場合があります。その場合は[PR #11](https://github.com/asumax1128/mathjong/pull/11)を開いてブランチ `docs/director-handoff-2026-10-26` を選んでください。mainへのマージはオーナーの別途承認が必要です。

## 遊ぶ（Ver.0.4-B）

人間1人＋AI3人。数学Ⅰ（124枚）／数学Ⅱ（168枚）、4局/8局、初級/中級/上級AI、2段階ヒント、チー/ポン独立オートパス、親・連荘と精算を搭載。

- **公開ゲーム**：<https://asumax1128.github.io/mathjong/>（2026-10-26、オーナーからiPhone Safari実機7項目合格報告）。
- **ソース実装記録**：[Ver.0.3-A](docs/14-ver0.3-a.md)、[Ver.0.3-B](docs/15-ver0.3-b-hints.md)、[Ver.0.4-A](docs/16-ver0.4-a-match.md)、[Ver.0.4-B](docs/17-ver0.4-b-ai-autopass.md)。
- **Codex独立監査と受入**：[監査・実機承認記録](docs/19-ver0.4-b-independent-audit-acceptance.md)。監査P0〜P2検出なし、P3改善3件は未対応。

```bash
node tools/serve.mjs             # http://localhost:8080/ でローカル試遊
npm test                         # Node.js単体・対局テスト
node tests/e2e/play.mjs          # Playwright E2E（対応するChromium環境が必要）
```

iPhone実機ではmainマージ後の既存GitHub Pagesを利用します。専用プレビューサイトは原則作りません。設定や結果の再現・テスト詳細は[実機テスト手順](docs/12-iphone-test-guide.md)。

## ゲームの核（現行の試作仕様）

- 関数牌（sin/cos/tan）＋角度牌＋結果牌による正しい3牌数式面子、または同一牌の刻子。
- 配牌8枚、通常9枚・3面子の和了。特殊和了あり。門前は役なし和了可、鳴いたら役が必要。
- チー／ポン／ロン／ツモを実装。宣言の優先順位は **ロン＞ポン＞チー**。
- 数学Ⅰ124枚と数学Ⅱ168枚を採用。角度/値/役の厳密な条件は現行`src/engine`と版別記録を参照。
- 役点・役満評価は現在のゲームでは**暫定採点**。初期計画の未決定事項は歴史資料として残しており、そのまま現行の未実装リストにはしない。

## 資料の目次

| 資料 | 内容 |
| --- | --- |
| [旧ゲームルール（2026-10-24）](docs/01-game-rules.md) | 初期の試作記録。現行ルールのSSOTではない |
| [牌一覧と三角関数値表](docs/02-tiles-and-values.md) | 17角度、13結果値、山の内訳 |
| [役・役満一覧](docs/03-yaku-catalog.md) | 三関制覇、象限一色、九角無双など |
| [シミュレーション履歴](docs/04-simulation-history.md) | 4人戦と12/16枚比較の結果、限界 |
| [旧決定ログ](docs/05-decision-log.md) | 2026-10-24時点の意思決定履歴。現行はDECISIONS参照 |
| [次の検証タスク](docs/06-next-steps.md) | ルール設計と実装の優先順位 |
| [旧開発ロードマップ](docs/09-roadmap.md) | 初期段階の計画案。現行はROADMAP参照 |
| [再現性と既知の制約](docs/07-simulation-reproducibility.md) | 既存簡易シミュレーターの注意点 |
| [公式ライブラリ・過去案](docs/08-formula-library-and-history.md) | 数式組立型や加法定理などの将来構想 |
| [Ver.0.1 実装記録](docs/10-ver0.1-implementation.md) | Web 試作版の仕様・暫定採用・テスト結果・既知の問題 |
| [実機テストと独立監査](docs/11-audit-and-device-testing.md) | iPhoneでのテスト手順、Claude→CodexのPR監査フロー |
| [Codex監査ガイド](AGENTS.md) | 独立監査の重点項目と報告形式 |
| [Ver.0.2 開発仕様](docs/13-ver0.2-spec.md) | 役ガイド・役候補ヒント・牌表示（A）、チーのオートパス（B）、横画面（C） |
| [Ver.0.3-A 実装記録](docs/14-ver0.3-a.md) | 数学Ⅰ／Ⅱ・刻子・ポン・新役（main統合済み） |
| [Ver.0.3-B ヒント実装記録](docs/15-ver0.3-b-hints.md) | 2段階ヒント・色枠（承認済み） |
| [Ver.0.4-A 対局システム実装記録](docs/16-ver0.4-a-match.md) | 4/8局・連荘・精算・試合終了（承認済み） |
| [Ver.0.4-B AI難易度＋ポンのオートパス](docs/17-ver0.4-b-ai-autopass.md) | 初・中・上級AIと独立自動パス（正式完成） |
| [iPhone 実機テスト手順](docs/12-iphone-test-guide.md) | テストURL、Pages 設定、固定seed、報告方法 |
| [旧シミュレーションコード](scripts/README.md) | Python検証プログラムの保存版と実行法 |
| [過去の集計結果](results/2026-10-24-function-12-vs-16.txt) | 2,500局×2条件の出力 |

## 直近の比較（各2,500局）

| 指標 | 関数牌 各12枚 | 関数牌 各16枚 |
| --- | ---: | ---: |
| 山の総枚数 | 156 | 168 |
| 4人合計の平均捨て牌数 | 27.794 | 27.608 |
| 門前型AI勝率 | 28.16% | 28.96% |
| チー経験者が和了した割合 | 28.28% | 28.80% |

これらは**簡易AIによる参考値**であり、最適戦略・人間の実力差・実力70%/運30%を証明しません。詳しくは[検証履歴](docs/04-simulation-history.md)。

## 運用方針

**2026-10-26以降の正式な開発運用手順は[WORKFLOW](docs/WORKFLOW.md)。以下は初期の研究ルールとして残す。**

- 仕様変更時は**決定ログ／ルール／役一覧／検証履歴**を整合させる。
- 予想・数学的に可能な組み合わせ・実測値を分ける。
- 過去の会話をすべて正式決定とみなさない。
- シミュレーションには簡略化や未実装項目があるため、検証コードとともに監査する。

このリポジトリは独立した新規プロジェクト **MATHJONG** 用です。他のゲーム開発リポジトリは対象外です。
