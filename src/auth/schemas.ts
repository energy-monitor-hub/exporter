import { z } from 'zod';

/** Every app API reply is wrapped like this; `message` is "Success" on success. */
export const envelopeSchema = z.object({
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string(),
  data: z.unknown().optional(),
});

export const loginDataSchema = z.object({
  token: z.string().min(1),
  user: z.object({
    userId: z.union([z.string(), z.number()]).transform(String),
    name: z.string().optional(),
  }),
});

export const certificationDataSchema = z.object({
  url: z.string().min(1),
  port: z.coerce.number().int().positive(),
  protocol: z.string().optional(),
  certificateAccount: z.string().min(1),
  certificatePassword: z.string().min(1),
});

export type LoginData = z.infer<typeof loginDataSchema>;
export type CertificationData = z.infer<typeof certificationDataSchema>;
