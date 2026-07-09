/*
  Warnings:

  - Added the required column `remain_tickets` to the `events` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable: thêm cột nullable trước (tránh lỗi existing rows)
ALTER TABLE "events" ADD COLUMN "remain_tickets" INTEGER;

-- Backfill: gán remain_tickets = total_tickets cho tất cả rows hiện có
UPDATE "events" SET "remain_tickets" = "total_tickets" WHERE "remain_tickets" IS NULL;

-- Sau khi đã có dữ liệu, mới set NOT NULL
ALTER TABLE "events" ALTER COLUMN "remain_tickets" SET NOT NULL;

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
