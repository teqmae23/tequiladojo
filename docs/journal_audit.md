# ジャーナル網羅性・注文消失調査（2026-07-06）

対象: 注文データ消失の原因究明。ジャーナル出力の網羅性、キー連携、来店→注文→会計フロー、管理画面操作の妥当性を調査。

## 1. 注文消失の有力な原因（修正済み）

### 1-a. 注文ID採番の障害時フォールバックによるサイレント上書き【最有力】
`home_order.html` の注文確定（confirmOrder）は、既存注文を2つのクエリで取得して
その日の最大連番（maxSeq）を求め、`日付+連番` のdocIDで `batch.set()` していた。
両クエリに `.catch(()=>({docs:[]}))` が付いており、**通信・権限エラー等で取得に失敗すると
「既存注文ゼロ」とみなして連番001から再採番**し、`batch.set()` がその日の既存注文
（001〜N）を**丸ごと上書き（＝消失）**する。ジャーナルは `create / before=null` で
記録されるため、上書き前のデータは残らない — 報告された症状と完全に一致する。

**修正**: クエリ失敗時は注文登録を中断してエラー表示（フォールバック廃止）。

### 1-b. 複数端末同時注文による連番競合
maxSeq の読み取り→採番→書き込みがトランザクション外のため、2端末が同時に注文確定すると
同じ連番を採番し、後勝ちで前者の注文が上書き消失する。

**修正**: `counters/orderSeq` ドキュメントに対する **Firestoreトランザクションで
必要数の連番レンジを原子的に確保**する方式に変更（日付ごとのフィールドで管理、
maxSeqとの大きい方を起点にするため既存IDとも衝突しない）。従来の commit 前重複チェックも
バックストップとして残置。

### 1-c. 会員の完全削除による注文の連鎖削除（ジャーナル皆無だった）
`admin_customer.html` の「完全削除」は、会員に紐づく visits / orders / cocktailOrders /
tempRegistrations / members / memberIndex を一括削除するが、**ジャーナルを一切
出力していなかった**。誤操作で削除された場合、痕跡ゼロで注文が消える。

**修正**: 削除前に全ドキュメントの内容を `delete` ジャーナルとして記録＋
`bulk-delete` サマリを記録。また旧形式 `visitId` フィールドで紐づく注文が
削除対象から漏れていた（孤児化）ため、visitId 検索も追加。

### 1-d. ジャーナル自体が14日で自動消滅していた
`journal.js` はページを開くたびに **14日より古いジャーナルを自動削除**していた。
「記録が残っていない」原因の一つ。過去の消失事象の証跡も既に失われている可能性が高い。

**修正**: 自動削除を廃止（手動クリーンアップは admin_data のジャーナルタブに存置、
既定90日に変更）。

## 2. ジャーナル網羅性の修正一覧

journal.js に `journaledUpdate` / `journaledSet`（**書き込み前にbeforeを読み取り、
before/after 両方を記録**）を追加し、FieldValueセンチネルのサニタイズを実装。

| ページ | 修正前の状態 | 修正内容 |
|---|---|---|
| checkin.html | 会計確定のジャーナルが before=null（しかも after はキャッシュ書き換え後の値）。退場処理・集計更新・一括退場・割引/案分レコードは記録漏れまたは架空docIDで記録 | 会計確定・退場・再計算・一括退場すべて before/after 記録。割引・案分は実docIDで commit 成功後に記録。tempRegistrations 発行も記録 |
| checkin.html | 会員累計（totalAmount/totalTequila）が**再会計のたびに二重加算**、更新失敗は握り潰し | 前回会計分（checkoutPayTime設定済み）を差し引く方式に修正、before/after 記録、失敗時トースト表示 |
| home_order.html | 提供/キャンセルの before が `{served:1}` 固定（実際は2/3もある）。cocktailOrders 未記録 | 実際の served 値を before に記録。cocktailOrders の作成も記録 |
| openclose.html | 休憩開始/終了・閉店・集計・備考・storeStatus・スタッフ自動退場・バッジ付与・会員バッジURL が記録漏れ or before=null | すべて journaledUpdate/journaledSet 化または before/after 付き記録 |
| admin_data.html | 営業/来店/予約/注文の編集ジャーナルが全て before=null。キー変更時の旧セッション削除は無記録。スケジュール保存（個別・一括コピー）は完全に無記録 | 編集前の状態をキャッシュから before として記録。旧キー削除は journaledDelete。スケジュールは保存前に既存を読み before/after 記録 |
| admin_customer.html | ソフトデリート・レイアウト保存・引継コード発行が無記録。完全削除が無記録（前述） | すべて記録 |
| attendance.html | **ジャーナル未導入**（出退勤・スタッフvisit作成/更新すべて無記録） | journal.js導入、全書き込みを記録 |
| reservations.html | **ジャーナル未導入**（予約の登録・更新・削除すべて無記録） | journal.js導入、journaledSet/journaledDelete化 |
| blind-result.js | blindResults作成・orders.served更新が無記録 | commit成功後に記録 |

※ 会員側ページ（mypage / member_register / member_register2）の members 更新は
今回未対応（スタッフ操作ではないため優先度低。必要なら同様に journal.js を導入可能）。

## 3. キー連携の調査結果

- **orders → visits**: 新形式は `visitKey`、旧形式は `visitId`。参照側は
  `visitKey===vk || visitId===vk` で両対応済み。ただし admin_data の注文編集は
  visitKey しか保存せず、**旧 visitId が別の来店を指したまま残ると1注文が
  2つの来店に紐づく**問題があった → 編集保存時に visitId を visitKey と同値に
  揃えるよう修正。編集フォームの来店ID表示も visitId フォールバックを追加。
- **visits → members**: `visits.memberId` に realId（membersのdocID）を格納。
  参照側は id/memberId/realId/displayId で解決しており整合。
- **sessions ↔ visits**: sessionId による直接リンクはなく、営業日＋開店時刻の
  時間窓（AuthRole.isVisitInSession）で判定する設計（過去の field-migration で
  リンクフィールドは意図的に廃止済み）。日またぎ・2日以内判定も実装済みで妥当。
- **visitsのdocID採番**（checkin: `日付+連番2桁`）: 書き込み直前に存在チェックが
  あるが、トランザクションではないため複数端末同時チェックインで理論上競合しうる
  （1日99件上限）。注文ほどのリスクではないため今回は未変更（要観察）。
- **reservations のID採番**（`西暦2桁+連番4桁`）: ローカルリストとの重複チェックのみ。
  同時操作で競合しうるが低頻度のため未変更。

## 4. 来店→注文→会計フローの妥当性

1. 開店（openclose）: sessions 作成 → storeStatus/RTDB 公開 → 出勤スタッフを自動チェックイン ✓
2. 来店（checkin）: visits 作成（会員は visitCount+1、新規はゲスト会員も作成）✓
3. 注文（home_order）: orders 作成（batchId/orderGroupId/visitKey 付与）→ 採番修正済み
4. 会計（checkin）: visits に金額・支払・会計時刻を記録、割引・案分は orders に
   adjustment レコード追加、members 累計更新（**二重加算バグ修正済み**）✓
5. 閉店（openclose）: closeTime 記録 → スタッフ自動退場 → 来場数・売上集計 →
   バッジ自動判定 ✓

集計値（visits.amount）は orders からの再計算で常に復元可能な設計のため、
注文本体さえジャーナルで守れば会計値も復元可能。

## 5. 残課題（今回未修正・要判断）

1. **firestore.rules**: 会員として自己登録した任意のユーザーが全コレクション
   （journals含む）を書き換え・削除できる。ジャーナルを証跡として信頼するには
   ルールでの保護（staff/owner以外の書き込み禁止、journalsの更新・削除禁止）が必須。
   （前回監査の指摘と同一。Custom Claims の付与状況確認後に段階適用を推奨）
2. admin_data の「クリーンアップ」（期限前データ全削除）は CSVバックアップ必須化＋
   確認ダイアログ＋件数ジャーナルのみ（per-docは件数が大きく非現実的）。CSV保管の
   運用ルール化を推奨。
3. ジャーナルはクライアント側 fire-and-forget のため、書き込み失敗時は console warn のみ。
   厳密な監査が必要なら Cloud Functions（onWrite トリガー）でのサーバー側ジャーナルが確実。
4. 完全削除で memberBadges / blindResults は削除対象外（孤児データが残る）。
