# Migration notes

## Runtime

- Node.js 18 or newer (Node.js 20 is used by the Docker image)
- Install: `npm ci`
- Start: `npm start`
- Health endpoint: `GET /`
- LINE webhook endpoint: `POST /webhook`
- Local tests: `npm test`
- Read-only LINE and Google Calendar connectivity check: `npm run check:external`

## Linking direct calendar bookings to LINE

An administrator listed in `ADMIN_USER_IDS` can send `顧客紐付け` to the bot, then enter the
customer name and LINE user ID. Direct Google Calendar events containing that name will be imported
when the customer sends `予約` or `予約確認`.

Ticket purchase notifications can be sent to a company LINE group. Enable group participation for the
official account, invite the bot, send `グループID確認` in that group, and set the returned value as
`ADMIN_NOTIFICATION_GROUP_ID`.

## External services

- LINE Messaging API: channel access token and channel secret
- Google Calendar API: service-account JSON key encoded as Base64
- Each staff calendar must be shared with the service-account email with permission to edit events
- Rich-menu setup is a separate one-time task: `node scripts/setupRichMenu.js richmenu_final.jpg`

## Configuration

Copy `.env.example` to `.env` and fill in the required values. The current configuration uses
`STAFF_LIST`; the older `GOOGLE_CALENDAR_ID` variable is no longer read by the application.

Never commit `.env`, `.env.save`, `env.yaml`, service-account JSON keys, or exported customer data.
The supplied archive contained populated secret files, so rotate the LINE channel access token,
LINE channel secret, and Google service-account private key if that archive has been shared or stored
outside a trusted location.

## Firestore persistence

Bookings, memberships, ticket balances, and customer links are stored in Firestore collections.
Create the `(default)` Firestore database in `asia-northeast1` and grant the Cloud Run runtime service
account the `roles/datastore.user` role before deployment. Existing JSON data can be imported once
with `npm run migrate:firestore`; the files remain excluded from Git and Docker build contexts.
