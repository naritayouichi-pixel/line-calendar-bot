# クラウド環境からの管理手順

このプロジェクトは、非公開GitHubリポジトリをコードの保管元にすることで、
ローカルCodexとクラウド上の開発環境の両方から管理できます。

## 管理対象

- アプリケーションコードと予約画面
- 固定シフトと予約ルール
- テスト
- Cloud Runへのデプロイ手順
- Cloud Schedulerの設定スクリプト

## GitHubへ保存しないもの

- `.env`、`.env.save`、`env.yaml`
- LINE・Google・Squareのトークンや秘密鍵
- Firestoreの顧客情報、LINEユーザーID、予約データ
- `data/*.json`

これらは`.gitignore`と`.dockerignore`で除外します。本番のシークレットは
Google Secret ManagerまたはCloud Runの環境変数を継続利用します。

## クラウド側で最初に行うこと

```bash
git clone <非公開GitHubリポジトリのURL>
cd line-calendar-bot
npm ci
npm run check
npm test
gcloud auth login
gcloud config set project line-calendar-bot-504511
```

Cloud RunとFirestoreをローカル確認する場合は、Google Cloudの認証も行います。

```bash
gcloud auth application-default login
```

## 本番デプロイ

環境変数やSecret Managerの設定を置き換えないよう、通常は次のコマンドだけを使います。

```bash
gcloud run deploy line-calendar-bot \
  --source . \
  --region asia-northeast1 \
  --project line-calendar-bot-504511 \
  --allow-unauthenticated
```

`--set-env-vars`は既存環境変数を全削除して置き換えるため使用しません。
設定を追加・変更するときは`--update-env-vars`または`--update-secrets`を使います。

## 定期処理

```bash
bash scripts/setupReservationReminderSchedulers.sh
```

- プラチナ会員の案内：毎月18日 8:00
- 通常月会費会員の案内：毎月25日 8:00
- 予約開始：各対象日の10:00

チケット自動消費と体験仮予約解除のSchedulerは、既存の本番設定を維持します。

## 変更時の必須確認

```bash
npm run check
npm test
npm run check:external
```

`check:external`はLINEとGoogleカレンダーへ接続するため、本番用環境変数または`.env`が必要です。

## データの保存場所

- 顧客紐付け：Firestore `customers`
- 月会費会員：Firestore `members`
- プラチナ名簿：Firestore `platinumMembers`
- チケット残数：Firestore `tickets`
- 予約：Firestore `bookings`
- 体験予約：Firestore `trialBookings`

デプロイしてもFirestoreのデータはリセットされません。

## 障害時の確認順序

1. Cloud Runの最新リビジョンが100%トラフィックを受けているか確認
2. `npm test`を実行
3. Cloud Runログで起動エラーを確認
4. Schedulerが`ENABLED`か確認
5. LINE、Google Calendar、Firestore、Squareの接続設定を確認

```bash
gcloud run services describe line-calendar-bot \
  --region asia-northeast1 \
  --project line-calendar-bot-504511

gcloud scheduler jobs list \
  --location asia-northeast1 \
  --project line-calendar-bot-504511
```

## 運用上の原則

- 変更前にGitHubの最新版を取得する
- 変更後はテスト合格後にコミットする
- 本番デプロイしたコミットをGitHubへ必ず反映する
- シークレットや顧客データをチャットやGitHubへ貼らない
- 本番データを変更する前に対象の氏名・LINE ID・コースを照合する
