import express from "express";
import { Request, Response } from "express";
import { db } from "./configs/db";
import { CreateEventSchema } from "./validators/event.validator";

const app = express();
app.use(express.json());

const PORT = 3000;
app.get("/health", (req: Request, res: Response) => {
  res.json({ status: "Ok" });
});
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy kịch trần tại http://localhost:${PORT}`);
});

app.get("/events", async (req: Request, res: Response) => {
  try {
    const events = await db.event.findMany();
    res.json(events);
  } catch (error) {
    console.error("Lỗi khi lấy danh sách sự kiện:", error);
    res.status(500).json({ error: "Không thể lấy danh sách sự kiện" });
  }
});

app.post("/events", async (req: Request, res: Response) => {
  const result = CreateEventSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({
      error: "Dữ liệu không hợp lệ",
      details: result.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    const newEvent = await db.event.create({ data: result.data });
    res.status(201).json(newEvent);
  } catch (error) {
    console.error("Lỗi khi tạo sự kiện:", error);
    res.status(500).json({ error: "Không thể tạo sự kiện" });
  }
});
