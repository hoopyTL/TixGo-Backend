import { z } from "zod";

// NUMERIC(12,2): at most ten integral digits and two fractional digits.
// Strings are the exact wire format; compatible numbers must stringify losslessly
// into the same decimal grammar, without coercion, exponent notation or rounding.
export const PriceSchema = z.preprocess(
  (value) => typeof value === "number" ? String(value) : value,
  z.string()
    .refine(
      (value) => value === value.trim() && /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value),
      "Price must be a nonnegative decimal with at most two fractional digits",
    )
    .transform((value) => {
      const [whole, fraction = ""] = value.split(".");
      return `${whole}.${fraction.padEnd(2, "0")}`;
    }),
);

export function formatPrice(value: { toFixed(digits: number): string }): string {
  return value.toFixed(2);
}
