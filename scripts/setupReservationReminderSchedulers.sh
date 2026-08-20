#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="line-calendar-bot-504511"
REGION="asia-northeast1"
SERVICE_URL="https://line-calendar-bot-752329396862.asia-northeast1.run.app"

AUTOMATION_SECRET="$(gcloud scheduler jobs describe ticket-auto-consumption \
  --location "$REGION" \
  --project "$PROJECT_ID" \
  --format='value(httpTarget.headers.x-automation-secret)')"

if [[ -z "$AUTOMATION_SECRET" ]]; then
  echo "既存の自動処理用シークレットを取得できませんでした。"
  exit 1
fi

upsert_job() {
  local job_name="$1"
  local schedule="$2"
  local member_type="$3"
  local uri="${SERVICE_URL}/tasks/send-monthly-reservation-reminder?type=${member_type}"

  if gcloud scheduler jobs describe "$job_name" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "$job_name" \
      --location "$REGION" \
      --project "$PROJECT_ID" \
      --schedule "$schedule" \
      --time-zone "Asia/Tokyo" \
      --uri "$uri" \
      --http-method POST \
      --headers "x-automation-secret=${AUTOMATION_SECRET}"
  else
    gcloud scheduler jobs create http "$job_name" \
      --location "$REGION" \
      --project "$PROJECT_ID" \
      --schedule "$schedule" \
      --time-zone "Asia/Tokyo" \
      --uri "$uri" \
      --http-method POST \
      --headers "x-automation-secret=${AUTOMATION_SECRET}"
  fi
}

upsert_job "monthly-reservation-reminder-platinum" "0 8 18 * *" "platinum"
upsert_job "monthly-reservation-reminder-regular" "0 8 25 * *" "regular"

echo "予約開始通知を設定しました。"
echo "プラチナ会員: 毎月18日 8:00"
echo "通常月会費会員: 毎月25日 8:00"
