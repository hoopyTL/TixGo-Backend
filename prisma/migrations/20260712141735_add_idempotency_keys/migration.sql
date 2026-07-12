-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "response_status" INTEGER,
    "response_body" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_key_key" ON "idempotency_keys"("user_id", "key");

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
