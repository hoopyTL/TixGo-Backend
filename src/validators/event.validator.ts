import { z } from 'zod'
import { PriceSchema } from '../utils/money'

// Seat creation is synchronous; bound its write amplification separately from int4 storage.
export function maxEventSeats() {
    const maximum = Number(process.env.MAX_EVENT_SEATS ?? 10000);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 2147483647) {
        throw new Error('Invalid MAX_EVENT_SEATS');
    }
    return maximum;
}

export const CreateEventSchema = z.object({
    title: z.string().min(1, 'Không được để trống'),
    description: z.string().optional(),
    location: z.string().optional(),
    // PostgreSQL INTEGER representation limit, not a business capacity cap.
    totalTickets: z.number().int().positive().max(2147483647)
        .refine(value => value <= maxEventSeats(), 'Capacity exceeds the synchronous seat creation limit'),
    organizerId: z.string().uuid().optional(),
    price: PriceSchema
}).strict()

export type CreateEventInput = z.infer<typeof CreateEventSchema>
