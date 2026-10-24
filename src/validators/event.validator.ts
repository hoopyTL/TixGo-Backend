import { z } from 'zod'

export const CreateEventSchema = z.object({
    title: z.string().min(1, 'Không được để trống'),
    description: z.string().optional(),
    location: z.string().optional(),
    // PostgreSQL INTEGER representation limit, not a business capacity cap.
    totalTickets: z.number().int().positive().max(2147483647),
    organizerId: z.string().uuid().optional(),
    price: z.number().min(0, "Price cannot be negative")
}).strict()

export type CreateEventInput = z.infer<typeof CreateEventSchema>
