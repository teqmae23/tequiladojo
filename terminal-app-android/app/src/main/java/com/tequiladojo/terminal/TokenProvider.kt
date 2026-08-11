package com.tequiladojo.terminal

import com.google.firebase.functions.FirebaseFunctions
import com.stripe.stripeterminal.external.callable.ConnectionTokenCallback
import com.stripe.stripeterminal.external.callable.ConnectionTokenProvider
import com.stripe.stripeterminal.external.models.ConnectionTokenException

/**
 * Stripe Terminal が要求する接続トークンを、Cloud Function
 * `terminalConnectionToken`（us-central1・スタッフ認証必須）から取得する。
 * 事前に Firebase Auth でスタッフとしてログインしている必要がある。
 */
class TokenProvider : ConnectionTokenProvider {
    override fun fetchConnectionToken(callback: ConnectionTokenCallback) {
        FirebaseFunctions.getInstance("us-central1")
            .getHttpsCallable("terminalConnectionToken")
            .call()
            .addOnSuccessListener { result ->
                @Suppress("UNCHECKED_CAST")
                val data = result.data as? Map<String, Any?>
                val secret = data?.get("secret") as? String
                if (secret.isNullOrEmpty()) {
                    callback.onFailure(ConnectionTokenException("接続トークンが取得できませんでした"))
                } else {
                    callback.onSuccess(secret)
                }
            }
            .addOnFailureListener { e ->
                callback.onFailure(ConnectionTokenException("接続トークン取得に失敗しました", e))
            }
    }
}
