-- Existing global keys are already unique, so this preserves every stored response.
ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_pkey";
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("user_id", "key");
DROP INDEX "idempotency_keys_user_id_key_key";
