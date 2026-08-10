# Stripe Terminal（対面カード決済）セットアップ手順

会計画面（checkin.html）で「会計方法＝2: カード（Stripe）」を選ぶと、Stripeの
スマート端末（WisePOS E / Stripe Reader S700 など）で対面カード決済を行い、
成功後に会計を確定します（サーバー主導方式）。

決済処理は Cloud Functions（us-central1）で行います。**Functionsは自動デプロイ
されない**ため、下記の手動デプロイが必要です。

---

## 1. 前提（Stripeアカウント側）

1. Stripeダッシュボードで **Terminal** を有効化。
2. **ロケーション（Location）** を作成：Terminal → ロケーション → 追加。
3. **リーダー（Reader）を登録**：対象のスマート端末をロケーションに紐付けて登録。
   - 登録後、リーダーの **Reader ID（例: `tmr_xxx`）** を控える。
   - テストは Stripe の **シミュレートリーダー**（`tmr_` のテスト端末）でも可能。

## 2. シークレット（既存のものを流用）

決済関数は既存のサブスク決済と同じ `STRIPE_SECRET_KEY` を使います。未設定の場合のみ：

```bash
firebase functions:secrets:set STRIPE_SECRET_KEY
# プロンプトに Stripe のシークレットキー（sk_live_... または sk_test_...）を貼り付け
```

## 3. Functions をデプロイ（手動・必須）

追加された関数：
- `terminalCollectPayment` … PaymentIntent作成＋端末へ送信
- `terminalPaymentStatus` … 状態ポーリング
- `terminalCancelPayment` … 進行中の決済を中止
- `terminalListReaders` … 設定画面用に端末一覧を取得

```bash
cd functions
npm install            # 初回のみ（stripe パッケージは package.json に既存）
cd ..
firebase deploy --only functions:terminalCollectPayment,functions:terminalPaymentStatus,functions:terminalCancelPayment,functions:terminalListReaders --project tequiladojo
# まとめて全関数でも可: firebase deploy --only functions --project tequiladojo
```

## 4. 端末IDを登録（アプリ側・オーナー権限）

1. 会計画面（checkin.html）でお会計モーダルを開く。
2. 「会計方法」ラベル横の **⚙️端末** をタップ。
3. 「端末一覧を取得」で登録済みリーダーを表示 → 使う端末をタップ（Reader IDが入力される）。
   - 直接 Reader ID を貼り付けてもOK。
4. **保存**（`settings/terminalConfig.readerId` に保存。保存はオーナー権限が必要）。

## 5. 使い方

1. 会計対象を選び「💳 会計」→ お会計モーダル。
2. 会計方法で **2: カード（Stripe）** を選ぶ。
3. 「✅ お会計確定」→ 端末に金額が送信され、オーバーレイに「カードをタッチ／挿入」表示。
4. お客様が端末でカード操作 → 成功でオーバーレイが消え、会計が確定（`visits.payment=2`、
   `visits.stripePaymentIntentId` に決済IDを保存）。
5. 失敗・タイムアウト時は「決済をキャンセル」でやり直し。

---

## 補足・仕様

- **通貨はJPY（ゼロ十進通貨）**。金額はそのまま「円」で送っています（×100しない）。
- **キャプチャは即時**（`capture_method: 'automatic'`）。読み取り成功と同時に売上確定。
- 金額上限のガード：¥1,000,000。
- 返金・キャンセル（確定後）はStripeダッシュボード側で操作してください（本実装は会計時の
  収納のみ）。必要なら返金関数も追加できます。
- 決済関数は `assertStaff` でスタッフ権限を要求します。端末設定の保存はオーナー権限です
  （`settings/{id}` の書込はオーナー、読取は認証済み）。
