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

### 準備（毎営業）
1. アプリ起動 → **スタッフのメール/パスワードでログイン**。
2. **Location ID（`tml_...`）** を入力（初回のみ・端末に保存されます）。
3. **「WisePad 3 に接続」** → 端末の電源を入れて待つ → 「接続完了（会計画面からの決済を待ち受け中）」。

### 会計画面（checkin.html）との自動連携（推奨）
接続後は、POSの会計画面から**金額が自動で流れてきます**（手入力不要）。
1. POSのお会計モーダルで会計方法「**2: カード**」を選ぶ → **「💳 WisePad 3 で決済」** パネルが表示。
2. 金額（総合計が初期値）を確認 → **「端末に送信」**。
3. このアプリが自動で受信し、**WisePad 3 にカードをタッチ/挿入** → 決済。
4. 結果（成功/失敗）は**POS側の画面にも自動反映**されます。成功後、POSで会計確定（記録）。

> 仕組み: 会計画面が Firestore の `terminalPayments` に決済リクエスト（`status:'pending'`）を作成 →
> このアプリが受けて `processing` に更新 → 決済 → `succeeded`(+`paymentIntentId`) / `failed`(+`errorMessage`)
> を書き戻します。`firestore.rules` に `terminalPayments`（スタッフのみ read/write）が必要です（同梱PRで追加済み）。

### 手入力でも決済可（連携なしのフォールバック）
アプリ内で **金額（円）** を入力 → **「決済する」** でも単独決済できます。
この手入力決済も `terminalPayments` に **`source:'app'`** で記録され、管理ページ
「カード決済ログ」で会計画面経由（`source:'checkout'`）と区別して確認できます。

---

## 補足・仕様
- **通貨は JPY**（ゼロ十進）。金額は「円」そのまま（×100しない）。
- **キャプチャは即時**（`capture_method: automatic`）。
- **返金**は、POSの「↩返金（記録）」＋ Stripeダッシュボードでの返金、または別途返金機能の追加で対応できます。
- 複数端末を運用する場合、`MainActivity.discoverAndConnect()` は「最初に見つかった端末」に接続します。
  シリアル番号で選別するよう調整してください。

## うまくいかないとき
- **決済時に「No active reader」/「読み取り失敗・中断」**: 決済の途中で WisePad 3 の Bluetooth が
  切れています。本アプリは `autoReconnectOnUnexpectedDisconnect = true`（SDK v4）で自動再接続しますが、
  以下も確認してください。① 初回接続時のファームウェア更新を最後まで完了（数分・放置）。② 端末を満充電
  （ケーブルを挿したまま運用可）。③ 決済中はスマホを端末の30cm以内に。④ 決済直前に端末の画面を点灯。
- **「別の決済を処理中です」から戻らない**: アプリの **「リセット（決済が止まった時）」ボタン** を押すと、
  処理中フラグを解除して待ち受けに戻せます（アプリ再起動は不要）。
- **ビルドエラー（API不一致）**: SDK v4 では接続は `Terminal.connectReader(reader, config, callback)` に統一
  （旧 `connectBluetoothReader` は廃止）。listener（`MobileReaderListener`）と自動再接続フラグは
  `BluetoothConnectionConfiguration` に渡します。確定は `confirmPaymentIntent`（旧 `processPayment`）。
- **接続できない**: Bluetooth/位置情報の権限を許可、端末を充電、他アプリとのペアリングを解除。
- **`permission-denied`**: ログインアカウントが staff/owner ロールか確認（`assertStaff`）。
- **`resource_missing`/決済不可**: Location ID が正しいモード（本番/テスト）のものか確認。
