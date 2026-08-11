# テキーラ道場 決済アプリ（Android・WisePad 3）

BBPOS **WisePad 3**（Bluetoothモバイル端末）で**対面カード決済**を行う、Android専用の最小アプリです。
Stripe Terminal Android SDK を使い、Bluetoothで端末に接続して決済します。決済が成功したら、
POS（checkin.html）側では会計方法「カード」で記録してください（金額の突合のため）。

```
[このAndroidアプリ] --Bluetooth--> [WisePad 3]
        |
        └─ Cloud Functions（us-central1）
              terminalConnectionToken     … 接続トークン
              terminalCreatePaymentIntent … 金額→PaymentIntent
```

> ⚠️ **重要**: このアプリはコード一式です。**ビルドとインストールはご自身の環境（Android Studio）で行う必要があります。** また、Stripe Terminal Android SDK は版により API が変わります。ビルドが通らない箇所は、ソース内の `// SDK-VERSION` コメントを、インストール済みSDK版のドキュメントに合わせて調整してください。

---

## 必要なもの
- **Android Studio**（最新版）、JDK 17
- **Androidスマホ/タブレット**（Android 8.0 / API 26 以上、Bluetooth対応）
- **WisePad 3** 本体（充電済み）
- Firebase プロジェクト `tequiladojo` の権限、Stripe アカウント権限

---

## セットアップ手順

### 1. Cloud Functions をデプロイ（サーバー側）
このリポジトリに追加済みの 2 関数をデプロイします（**Functionsは手動デプロイが必要**）。
```bash
cd functions
npm install
cd ..
firebase deploy --only functions:terminalConnectionToken,functions:terminalCreatePaymentIntent --project tequiladojo
```
`STRIPE_SECRET_KEY` は既存（サブスク決済用）を流用します。未設定なら:
```bash
firebase functions:secrets:set STRIPE_SECRET_KEY
```

### 2. Stripe Terminal のロケーションを作成
Stripeダッシュボード → 端末(Terminal) → ロケーション → 追加（国=日本, 住所）。
発行される **Location ID（`tml_...`）** を控えます（アプリで入力します）。
※ 本番/テストでモードごとに別IDです。

### 3. Firebase に Android アプリを登録（google-services.json）
1. Firebase コンソール → プロジェクト `tequiladojo` → プロジェクト設定 → 「アプリを追加」→ Android。
2. **パッケージ名は `com.tequiladojo.terminal`**（このアプリの applicationId と一致必須）。
3. `google-services.json` をダウンロードし、**`terminal-app-android/app/google-services.json`** に置く。
4. 認証は既存の **メール/パスワード**を使用。決済関数は `assertStaff` でスタッフ権限を要求するので、
   ログインに使うアカウントが **owner/staff ロール**であること（既存のスタッフアカウントでOK）。

### 4. ビルド＆インストール
1. Android Studio で **`terminal-app-android/`** フォルダを開く（Gradle同期）。
2. `app/build.gradle` の Stripe Terminal のバージョン（`def terminal = '4.4.0'`）を、
   [最新の安定版](https://github.com/stripe/stripe-terminal-android/releases) に合わせる。
3. 実機をUSB接続 → Run（▶）でインストール。
   ※ Google Play 配布は不要。社内端末に直接インストール（開発者モード/USBデバッグ）で運用可。

### 5. 端末（WisePad 3）の準備
- 充電し、電源ON。初回接続時にファームウェア更新が走ることがあります（数分・接続維持）。
- アプリからの接続時に Bluetooth ペアリングされます。

---

## 使い方
1. アプリ起動 → **スタッフのメール/パスワードでログイン**。
2. **Location ID（`tml_...`）** を入力（初回のみ・端末に保存されます）。
3. **「WisePad 3 に接続」** → 端末の電源を入れて待つ → 「接続完了」。
4. **金額（円）** を入力 → **「決済する」** → 端末にカードをタッチ/挿入 → 「✅ 決済完了」。
5. POS（checkin.html）で会計方法「**カード**」を選んで会計確定（記録）。

---

## 補足・仕様
- **通貨は JPY**（ゼロ十進）。金額は「円」そのまま（×100しない）。
- **キャプチャは即時**（`capture_method: automatic`）。
- **返金**は、POSの「↩返金（記録）」＋ Stripeダッシュボードでの返金、または別途返金機能の追加で対応できます。
- 複数端末を運用する場合、`MainActivity.discoverAndConnect()` は「最初に見つかった端末」に接続します。
  シリアル番号で選別するよう調整してください。

## うまくいかないとき
- **ビルドエラー（API不一致）**: `// SDK-VERSION` の箇所を、使用中のSDK版のサンプルに合わせて修正。
  特に `discoverReaders` / `connectBluetoothReader` / `confirmPaymentIntent`（旧 `processPayment`）。
- **接続できない**: Bluetooth/位置情報の権限を許可、端末を充電、他アプリとのペアリングを解除。
- **`permission-denied`**: ログインアカウントが staff/owner ロールか確認（`assertStaff`）。
- **`resource_missing`/決済不可**: Location ID が正しいモード（本番/テスト）のものか確認。
