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

## 会員ページ側の対応（同時修正済み）

新ルールでは「メールアドレスでの members / memberIndex 一括検索」を一般会員に許可しない
（他人のメールを列挙できてしまうため）。実メール会員の自己解決が壊れないよう、
mypage / tastinglog / member_map / member_register の会員解決を
**authUid クエリ優先**（`where('authUid','==',uid)` はルール上、自分の分だけ通る）に変更し、
旧ロジックは try/catch のフォールバックに降格した。
member_register.html は認証前に採番していたため、匿名サインインを前置した。

## 残存リスク（承知の上での設計判断）

1. **visits / orders は「認証済みなら読める」**（匿名含む）。
   mypage が自分の来店・注文を documentId の in クエリで引くため、所有者限定にできない。
   氏名等は含まれない（会員IDと金額のみ）。将来的に絞るなら Cloud Functions 経由に要改修。
2. **memberIndex / tempRegistrations の単一取得（get）は公開**。
   ログインID→メール解決と引継コードに必要。ID総当たりで会員のメールが1件ずつ露出しうる。
   一括列挙（list）はスタッフ限定にして影響を局所化した。
3. **members の未連携ドキュメントは、authUid を自分に書けば誰でも紐付け可能**
   （引継コードの検証はクライアント側のため）。厳密化するには引継処理の Functions 化が必要。
4. **settings/memberCounter は認証済みなら更新可**（登録フローで必要）。
   realSeq の巻き戻し（＝ID衝突・上書き）はルールで禁止済み。他フィールドの荒らしは可能。
5. **dotMunicipios は認証済み（匿名含む）で書き込み可**（地図キャッシュを閲覧時生成する設計）。
6. **RTDB（storeStatus）と Cloud Storage のルールはリポジトリ外**。
   RTDB は `.write: auth != null` 想定のため、会員でも店頭ステータスを書けてしまう。
   RTDB コンソールで `.write` を無効化し、openclose からの書き込みを Functions 経由にするか、
   当面は運用リスクとして許容するか要判断。
7. **journals への書き込みはスタッフのみ**になったため、証跡の信頼性が確保された
   （改変不可・削除はオーナーのみ。ownerはcatch-allで技術的には可能）。

## その他の同時対応

- news タイトルの HTML エスケープ（index.html / news.html）。本文は管理者入力のリッチHTML
  仕様のため据え置き。
- admin_data のニュース保存を journaledSet 化（before/after記録）。
- カレンダー: 生成HTMLは公開期間を超える月へのリンクを作らないことを確認
  （202608calendar.html は翌月リンクなし）。index.html のボタンは当月リンクのみで、
  公開期間内に必ず存在する。→ 追加対応不要。
