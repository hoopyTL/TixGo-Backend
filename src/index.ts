import express from "express";
import { Request, Response } from "express";

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

const events: Event[] = [];
app.get("/events", (req: Request, res: Response) => {
  res.json(events);
});

app.post("/events", (req: Request, res: Response) => {
  const { title, price, totalTickets } = req.body;

  const newEvent: Event = {
    id: Date.now().toString(),
    title,
    price,
    totalTickets,
  };

  events.push(newEvent);

  res.status(201).json(newEvent);
});
