import { z } from "zod";

export const itemOrderSchema = z.array(z.uuid());
