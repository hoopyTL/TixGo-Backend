import express from "express";
import { Request, Response } from "express";
import { db } from "./configs/db";

const app = express();
app.use(express.json());

const PORT = 3000;
app.get("/health", (req: Request, res: Response) => {
  res.json({ status: "Ok" });
});
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy kịch trần tại http://localhost:${PORT}`);
});

interface Event {
  id: string;
  title: string;
  price: number;
  totalTickets: number;
}

app.get("/events", async (req: Request, res: Response) => {
  try {
    const events = await db.event.findMany();
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: "Không thể lấy danh sách sự kiện" });
  }
});

app.post("/events", async (req: Request, res: Response) => {
  try {
    const { title, price, totalTickets } = req.body;

    const newEvent: Event = await db.event.create({
      data: { title, price: Number(price), totalTickets: Number(totalTickets) },
    });

    res.status(201).json(newEvent);
  } catch (error) {
    res.status(500).json({ error: "Không thể tạo sự kiện" });
  }
});
