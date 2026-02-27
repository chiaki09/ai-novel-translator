# Claude Codeへの初回プロンプト

---

以下をそのままClaude Codeの最初のメッセージに貼り付けてください。

---

## ① プロジェクト開始プロンプト（最初に一回だけ貼る）

```
このプロジェクトはChrome拡張機能（Manifest V3）です。
README.mdを読んで全体像を把握してください。
まずPhase 1のMVPを作ります。タスクを1つずつ実装してください。
```

---

## ② タスク1: 骨格を作る

```
以下を作成してください。

extension/manifest.json
- Manifest V3
- permissions: storage, activeTab, scripting
- content_scripts: すべてのURLに対してcontent.jsを読み込む
- action: popup.html
- background: service-worker.js
- options_page: options/options.html

extension/options/options.html と options.js
- Gemini APIキーを入力するテキストフィールド
- 「保存」ボタン → chrome.storage.localに保存
- 「テスト」ボタン → Gemini APIに簡単なリクエストを投げて成功/失敗を表示
- シンプルなHTML/CSSで良い（見た目は後で整える）
```

---

## ③ タスク2: Gemini APIラッパー

```
extension/utils/gemini.js を作成してください。

- chrome.storage.localからAPIキーを取得する関数
- Gemini 2.5 Flash APIにテキストを投げて日本語訳を返す関数 translateText(text)
- エンドポイント: https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent
- システムプロンプト込みで送る（README.mdの翻訳プロンプトを使う）
- エラー時はエラーメッセージを含むオブジェクトを返す
- APIキー未設定時は専用のエラーを返す
```

---

## ④ タスク3: コンテンツスクリプト

```
extension/content/content.js と content.css を作成してください。

content.js の仕様:
- chrome.runtime.onMessageでpopupからのメッセージを受け取る
  - { action: "translate" } → 翻訳実行
  - { action: "restore" } → 原文に戻す
- 翻訳対象の抽出: article, .chapter-content, .content, main p, body p の順で探す
- pタグを取得して、テキストを全部まとめてgemini.jsに渡す
- 取得した訳文でDOMのtextContentを置き換える（元のテキストはdata-original属性に保存）
- 翻訳中は対象要素にopacity: 0.5を適用
- restoreは data-original から元のテキストを復元する

content.css:
- .translating クラスのopacity制御
- それ以外は最小限
```

---

## ⑤ タスク4: ポップアップ

```
extension/popup/popup.html と popup.js と popup.css を作成してください。

仕様:
- 「翻訳する」ボタン → content.jsに { action: "translate" } を送る
- 翻訳済み状態では「原文に戻す」ボタンを表示
- 翻訳中はボタンを非活性化してローディングテキストを表示
- APIキー未設定の場合は「設定画面でAPIキーを入力してください」と表示してoptionsへのリンクを出す
- 設定ページへのリンクをフッターに配置
- デザインは横幅300px程度のシンプルなポップアップ
```

---

## ⑥ タスク5: キャッシュ

```
extension/utils/cache.js を作成してください。

- saveCache(url, translatedData) → chrome.storage.localに保存
- loadCache(url) → 保存済みの翻訳データを返す（なければnull）
- clearCache() → 全キャッシュ削除

content.jsとservice-worker.jsにキャッシュを組み込んでください:
- 翻訳前にキャッシュをチェック → あればAPIを叩かずに使う
- 翻訳後にキャッシュに保存
```

---

## ⑦ 動作確認後のお願いプロンプト集（状況に応じて使う）

```
# エラーが出たとき
以下のエラーが出ています。修正してください:
[エラーメッセージを貼る]

# 翻訳が正しく当たらないとき
[サイトのURL] でテストしたところ、本文ではなく [ヘッダー/広告/ナビ] が
翻訳されてしまいます。DOMセレクタを修正してください。

# UIを改善したいとき
ポップアップのデザインをもっときれいにしてください。
ダークテーマ・角丸・シャドウを使ってモダンな見た目にして。

# 翻訳品質を上げたいとき
翻訳プロンプトを改善してください。
現状の問題: [例: 固有名詞がバラバラに訳される / 口調が統一されない]
```

---

## 開発Tips

- 実装が終わったら `chrome://extensions` でリロードして即テスト
- エラーはchromeの「検証」→ Consoleで確認（content.jsはページのコンソール）
- service-worker.jsのログは 拡張機能一覧の「Service Worker」リンクから確認
- テスト用おすすめページ: https://www.royalroad.com/fiction/21220/mother-of-learning （英語・長文・無料）
