import { z } from 'zod'
import { PriceSchema } from '../utils/money'

export const CreateEventSchema = z.object({
    title: z.string().min(1, 'Không được để trống'),
    description: z.string().optional(),
    location: z.string().optional(),
    // PostgreSQL INTEGER representation limit, not a business capacity cap.
    totalTickets: z.number().int().positive().max(2147483647),
    organizerId: z.string().uuid().optional(),
    price: PriceSchema
}).strict()

export type CreateEventInput = z.infer<typeof CreateEventSchema>
