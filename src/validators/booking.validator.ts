import { z } from "zod";

export const CreateBookingSchema = z.object({
    eventId: z.string().uuid(),
});

export type CreateBookingInput = z.infer<typeof CreateBookingSchema>;
