const { Firestore } = require('@google-cloud/firestore');

// Cloud Runでは実行サービスアカウントのApplication Default Credentialsを自動利用する。
// FIRESTORE_PROJECT_IDは省略時にGoogle Cloudの現在のプロジェクトを使用する。
const db = new Firestore({
  ...(process.env.FIRESTORE_PROJECT_ID ? { projectId: process.env.FIRESTORE_PROJECT_ID } : {}),
});

module.exports = db;
