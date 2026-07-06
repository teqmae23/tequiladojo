# firestore.rules 移行ガイド（2026-07-06）

## 権限モデル

| ロール | 判定方法 | できること |
|---|---|---|
| **owner** | ①IDトークンの custom claim `role:'owner'`、または ②`staffRoles/{uid}` の `role:'owner'`（どちらかでOK） | 全コレクションの読み書き（catch-allで担保） |
| **staff** | 同上（`role:'staff'`） | 日常業務のみ: sessions / storeStatus / visits / orders / cocktailOrders / blindResults / memberBadges / counters / attendance / reservations / tempRegistrations / journals(作成) / members（来店カウント・ゲスト作成等） |
| **会員**（認証済・仮想/実メール） | ロールなし | 自分の members ドキュメントの読み書き、登録フロー（memberIndex / tempRegistrations / settings/memberCounter）、visits・orders 等の読み取り、マスタ読み取り |
| **匿名認証** | `sign_in_provider == 'anonymous'` | 公開ポータル・カタログ表示に必要な読み取り、dotMunicipios キャッシュ生成 |
| **未認証** | — | news / newsConfig / schedules / sessions / storeStatus / layouts / publicProfiles の読み取り、memberIndex・tempRegistrations の**単一取得のみ**（ログインID解決・引継コード用） |

ページ側ガードも方針に合わせ整理:
- `requireStaff`: home / openclose / checkin / home_order / attendance / receipt / blind-result-page
- `requireOwner`: admin（ハブ）/ admin_data / admin_customer / admin_badges / admin_tequila /
  admin_other / admin_cocktail / admin_distillery / admin_map / admin_tree /
  admin_distillerytree / admin_import_amm / admin_import_crt / admin_import_crt_coords /
  admin_amm_view / admin_crt_stats / admin_crt_stats2 / reservations

## ⚠ マージ（＝自動デプロイ）前チェックリスト

`.github/workflows/firebase-deploy.yml` は **main への push で hosting と firestore:rules を
自動デプロイ**する。マージ前に必ず以下を確認すること。

1. **260003（オーナー）の claim 確認**
   admin.html にログイン → 赤い警告バナーが**出ないこと**を確認
   （バナーは「claimも staffRoles/{uid} も無い」ときに表示され、対処方法を案内する）。
   手動確認する場合はブラウザコンソールで:
   ```js
   firebase.auth().currentUser.getIdTokenResult(true).then(r=>console.log(r.claims.role))
   ```
   → `owner` が出ればOK。
2. **出ない場合（どちらか一方でOK）**
   - admin_customer.html で自分の会員情報を開き `role: owner` のまま保存し直す
     （functions/setCustomClaims トリガーが claim を同期）→ 再ログイン。
   - または Firebase コンソール（ルールの影響を受けない）で
     `staffRoles/{自分のuid}` に `{ role: 'owner' }` を作成。
3. マージ・デプロイ後、260003 で以下を一通り実施して読み書きを確認:
   開店 → チェックイン → 注文 → 会計 → 閉店、admin_data でデータ編集、
   admin_customer で会員編集、mypage（会員アカウント）で自分の情報表示。

## 🆘 万一オーナーが書き込めなくなった場合

Firebase コンソールの Firestore エディタは**セキュリティルールを経由しない**。
コンソールで `staffRoles/{オーナーのuid}` に `{role:'owner'}` を作成すれば即復旧する
（uid は Authentication 画面で確認）。

## 第2段階（Functions化）— 2026-07-06 追記

会員から visits / orders / blindResults が読めてしまう問題は、**クライアント側で「はじく」
だけでは防御にならない**（悪意ある利用者はページを経由せず SDK を直接呼べる）ため、
Cloud Functions 経由に移行し、ルールで直接読み取り自体をスタッフ限定にした。

新設した Functions（すべて asia-northeast1）:

| 関数 | 権限 | 役割 |
|---|---|---|
| `getMemberActivity` | 会員本人（またはスタッフ＋previewMemberId） | 本人の visits / orders / 同一バッチのblindResults・同席者名をまとめて返す。mypage / tastinglog / member_map が使用 |
| `registerMember` | 認証不要（サーバー側で検証） | 会員登録（新規・引継コード両対応）。採番・Auth アカウント作成・members/memberIndex 作成・コード消込をサーバー権限で実行し、ジャーナルも記録 |
| `setStoreStatus` | staff/owner | 店頭ステータスを Firestore + RTDB の両方に書き込む（openclose.html が使用） |
| `getStoreStatus` | 認証不要 | 営業中/休憩中/閉店＋来店数/席数を返す（index.html が使用。visits を公開せずに来店数を表示できる） |

ルールの締め付け（第2段階）:
- visits / orders / cocktailOrders / blindResults / counters: **読み書きともスタッフ限定**
- members の作成・引継: Functions のみ（会員の自己claim条項を削除）
- memberIndex / tempRegistrations の書き込み: スタッフ・Functions のみ
- settings/memberCounter: スタッフ・Functions のみ

### ⚠ デプロイ順序（重要）

hosting と rules は main へのマージで自動デプロイされるが、**Functions は自動デプロイされない**。
新ページは新しい関数に依存するため、必ず以下の順で行うこと:

1. このブランチで `cd functions && npm install`（初回のみ）
2. `firebase deploy --only functions --project tequiladojo` を実行（マージ前に実行してよい。
   既存関数に影響はなく、新関数が追加されるだけ）
3. 関数のデプロイ完了を確認してからマージ（hosting + rules が自動デプロイされる）
4. RTDB コンソールでルールを `{ "storeStatus": { ".read": true, ".write": false } }` に変更
   （書き込みは setStoreStatus 関数経由のみになったため）

### デプロイ後の動作確認

- 260003: 開店 → トップページの営業表示（来店数）→ チェックイン → 注文 → 会計 → 閉店
- 会員アカウント: mypage の来場履歴・注文・ブラインド結果、試飲ログ、蒸留所マップの飲破NOM
- 新規会員登録（member_register2.html）と引継コード登録
- 会員アカウントでブラウザコンソールから
  `firebase.firestore().collection('orders').limit(1).get()` が **permission-denied になる**こと

## 会員ページ側の対応（同時修正済み）

新ルールでは「メールアドレスでの members / memberIndex 一括検索」を一般会員に許可しない
（他人のメールを列挙できてしまうため）。実メール会員の自己解決が壊れないよう、
mypage / tastinglog / member_map / member_register の会員解決を
**authUid クエリ優先**（`where('authUid','==',uid)` はルール上、自分の分だけ通る）に変更し、
旧ロジックは try/catch のフォールバックに降格した。
member_register.html は認証前に採番していたため、匿名サインインを前置した。

## 残存リスク（第2段階適用後）

1. ~~visits / orders は認証済みなら読める~~ → **解消**（スタッフ限定＋getMemberActivity経由）
2. **memberIndex の単一取得（get）は公開のまま**。
   ログインID→メール解決（mypageのID入力ログイン）に必要。ID総当たりで
   メールが1件ずつ露出しうる。一括列挙はスタッフ限定。
   ~~tempRegistrationsのget公開~~ → **解消**（registerMemberがサーバー側で検証）
3. ~~未連携members docを誰でも紐付け可能~~ → **解消**（引継はregisterMemberのみ）
4. ~~settings/memberCounterを会員が更新可~~ → **解消**（スタッフ・Functionsのみ）
5. **dotMunicipios は認証済み（匿名含む）で書き込み可**（地図キャッシュを閲覧時生成する設計）。
6. **RTDB（storeStatus）**: setStoreStatus関数経由に移行済み。
   RTDBコンソールで `.write: false` へ変更すること（上記チェックリスト参照）。
   **Cloud Storage のルールはリポジトリ外**のため未対応（バッジコレクション画像等）。
7. **journals への書き込みはスタッフのみ**（改変不可・削除はオーナーのみ）。
8. **registerMember は認証不要の公開エンドポイント**（従来のクライアント直接登録と同等）。
   スパム登録対策が必要になったら App Check や reCAPTCHA の導入を検討。
9. memberBadges は認証済みなら読める（member_collection が本人分をクエリするため。
   バッジ取得状況のみで個人情報は含まない）。

## その他の同時対応

- news タイトルの HTML エスケープ（index.html / news.html）。本文は管理者入力のリッチHTML
  仕様のため据え置き。
- admin_data のニュース保存を journaledSet 化（before/after記録）。
- カレンダー: 生成HTMLは公開期間を超える月へのリンクを作らないことを確認
  （202608calendar.html は翌月リンクなし）。index.html のボタンは当月リンクのみで、
  公開期間内に必ず存在する。→ 追加対応不要。
