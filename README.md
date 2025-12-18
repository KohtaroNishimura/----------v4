# 上等たこ焼き在庫管理アプリ概要

## 解決したい現場課題
- 閉店後に目視で在庫チェック → 足りない材料を手作業でLINE発注。
- 決まった日報テンプレートをLINEで送付するのに時間がかかる。
- 片付け・帰りの車内で在庫を整理してからLINEを送るため、終業までの負担が大きい。

## 現状のオペレーション
1. 1日の終わりに材料在庫を数える。
2. 不足分をLINEメッセージで発注  
   例: 「明日も13時半頃材料受け取り。サラダ油8個入り1パックの予備、出汁3セット、タコ1袋お願いします。」
3. 下記テンプレートで日報をLINE送信  
   ```
   1  ←処分したたこ焼き（ロス）
   5  ←セット数
   5.5←営業時間（生産性がある時間のみ）
   23,500←売上
   所感: 感じたこと／疑問点／改善点
   ```

## ユーザーの悩み
- 片付け作業が長引きやすい。
- 日報管理とLINE送信に時間を奪われる。
- 帰りの車内で在庫を計算 → その後LINE送信までが煩雑。

## 実現したい理想
- 材料棚の写真を撮るだけで不足在庫を自動判定し、LINEへ発注文を作成。
- 在庫発注と日報を1通のLINEでまとめて送信。
- 片付け中など移動前に日報を入力し終えられる軽量UI。

## 想定アーキテクチャ
| 機能 | 推奨ツール |
| --- | --- |
| UI（在庫撮影・日報入力） | Flask製Webアプリ（HTML/CSS/JS、モバイル対応） |
| 写真アップロード | Flask UIからの画像フォーム送信 |
| 写真解析（在庫判定） | YOLOv8 / YOLOv10（無料モデル） |
| サーバーサイド | Flask（Python） |
| データ保存 | Flaskサーバー内のJSONファイル（「当日の在庫」「日報」を保存） |
| メッセージ生成 | Flask内部で在庫・日報を整形 |
| LINE送信 | LINE Messaging API（無料枠） |

## 目指すプロダクト像
- 写真アップロードで不足在庫リストを即時生成し、推薦発注数・LINE文面を自動整形。
- 日報フォームはモバイル前提のミニWebアプリ。入力中は進捗をSupabase/Sheetに保存し、送信時に在庫情報と統合して1通のLINEを送付。
- すべての入力をログ化し、翌日の発注やロス分析、売上・稼働時間の可視化に活用。

## 開発・起動方法（ローカルプロトタイプ）

バックエンドは Flask を使ったシンプルな API（`backend/app.py`）です。フロントは `prototype/` にある静的ファイルをブラウザで開いて使えます。

- 依存パッケージ（仮想環境推奨）

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
```

- 環境変数（OpenAI を使う場合）

```bash
export OPENAI_API_KEY="<your_api_key>"
```

- バックエンド+フロント起動（ローカル）

```bash
python backend/app.py
```

サーバーを立ち上げると `http://localhost:8000/` でフロントエンドも同じ Flask から配信され、PC/スマホのブラウザでそのまま操作できます。

補足: `prototype/index.html` を直接 `file://` で開いた場合は、バックエンドが起動していない限り在庫・日報は `localStorage` にのみ保存されます（サーバー側のJSONストレージには書き込まれません）。サーバー側に保存する場合は、上記のように Flask を起動して `http://localhost:8000/` から開いてください。`http://...` で開いている場合、在庫/日報の変更のたびに `PUT /state` でサーバーへ即時同期されます。

注意: 画像解析は現状で外部の言語モデル（OpenAI Responses）へ委ねる設計になっています。将来的にYOLO等の検出モデルに差し替える場合は、`backend/app.py` の `analyze_inventory` 内の呼び出しを差し替えてください。

## Web公開とモバイルアクセス

アプリは 1 つの Flask サーバーがフロント(静的ファイル)と API をまとめて提供する形になりました。以下のいずれかの方法でインターネット上に公開できます。

### A. Docker でセルフホスト

```bash
docker build -t takoyaki-inventory .
docker run \
  -e OPENAI_API_KEY="sk-..." \
  -e MOCK_VISION=0 \
  -p 8000:8000 \
  takoyaki-inventory
```

サーバーの 8000 番ポートを外部公開し、スマホから `https://<your-domain>/` を開けば同じ UI を操作できます。サーバー側の `backend/app_state.json` / `backend/reports.json` にデータが書き込まれるため、永続化したい場合は `-v $(pwd)/backend:/app/backend` などのボリュームを付けて保存先ファイルをホスト側にマウントしてください。

### B. Render / Railway / Heroku などの PaaS にデプロイ

1. レポジトリを GitHub などに push。
2. PaaS で新しい Web Service を作成し、Python ビルドパックまたは `Dockerfile` を選択。
   - ビルドコマンド: `pip install -r backend/requirements.txt`
   - スタートコマンド: `gunicorn -b 0.0.0.0:$PORT backend.app:app`（`Procfile` にも同じ定義あり）
3. 環境変数を設定:
   - `OPENAI_API_KEY`: Vision を使う場合は必須。
   - `MOCK_VISION=1`: Vision モックで動かす場合に指定（本番利用では 0 または未設定）。
4. デプロイ完了後に発行された URL をスマホから開けば、写真アップロード・日報入力までブラウザだけで完結します。

PaaS のファイルシステムはリセットされることがあるので、在庫や日報を長期保存したい場合は Render のPersistent Diskや外部ストレージ（Supabase・Cloud Storage 等）への移行を検討してください。
