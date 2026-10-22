import { z } from 'zod'

export const CreateEventSchema = z.object({
    title: z.string().min(1, 'Không được để trống'),
    description: z.string().optional(),
    location: z.string().optional(),
    totalTickets: z.number().int().positive(),
    remainTickets: z.number().int().min(0).optional(),
    price: z.number().min(0, 'Giá vé không được nhỏ hơn 0')
}).strict()

export type CreateEventInput = z.infer<typeof CreateEventSchema>